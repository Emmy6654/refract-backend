import { DriftFinding, LocalPublishRecord, OnChainOracleEntry } from "./chain-reconciliation.types";

export interface ChainDiffOptions {
  /** Unix seconds treated as "now". */
  nowSec: number;
  /** Only entries newer than `nowSec - lookbackSeconds` are compared. */
  lookbackSeconds: number;
  /**
   * Entries newer than `nowSec - finalityBufferSeconds` are ignored, so a
   * write that is still propagating (or a receipt that is still being
   * written) is never reported as drift.
   */
  finalityBufferSeconds: number;
  /** Allowed |local.publishedAt - chain.ledgerClosedAt| before flagging. */
  timestampToleranceSeconds: number;
  /**
   * Submitters allowed to write to the oracle contract. When empty, writer
   * checks are skipped (every submitter is assumed authorised).
   */
  authorizedWriters: ReadonlySet<string>;
}

export interface ChainDiffWindow {
  start: number;
  end: number;
}

export function diffWindow(opts: ChainDiffOptions): ChainDiffWindow {
  return {
    start: opts.nowSec - opts.lookbackSeconds,
    end: opts.nowSec - opts.finalityBufferSeconds,
  };
}

/** One transaction can publish several feeds, so the key includes both. */
export function publishKey(e: { txHash: string; kind: string; feedId: string }): string {
  return `${e.txHash.toLowerCase()}:${e.kind}:${e.feedId}`;
}

/**
 * Pure, deterministic diff of local publish receipts against on-chain oracle
 * entries. No I/O — the reconciler feeds it data and acts on the result, so
 * every drift class can be tested with plain fixtures.
 *
 * Classification:
 *  - local receipt with no matching on-chain write  → missing_on_chain_value
 *  - matched, but the stored value differs          → value_mismatch
 *  - matched, value equal, time differs > tolerance → timestamp_mismatch
 *  - on-chain write from an unauthorised submitter  → unexpected_writer
 *  - on-chain write (authorised) with no receipt    → missing_local_receipt
 */
export function diffChainState(
  local: readonly LocalPublishRecord[],
  onChain: readonly OnChainOracleEntry[],
  opts: ChainDiffOptions,
): DriftFinding[] {
  const { start, end } = diffWindow(opts);
  const inWindow = (t: number) => t >= start && t <= end;

  const chainByKey = new Map<string, OnChainOracleEntry>();
  for (const entry of onChain) {
    if (!inWindow(entry.ledgerClosedAt)) continue;
    chainByKey.set(publishKey(entry), entry);
  }

  // A local receipt may be matched by a chain entry slightly outside the
  // window (clock skew), so index all chain entries for lookups.
  const allChainByKey = new Map<string, OnChainOracleEntry>();
  for (const entry of onChain) allChainByKey.set(publishKey(entry), entry);

  const findings: DriftFinding[] = [];
  const matchedKeys = new Set<string>();
  const localKeys = new Set<string>();

  for (const record of local) {
    const key = publishKey(record);
    localKeys.add(key);
    if (!inWindow(record.publishedAt)) continue;

    const entry = allChainByKey.get(key);
    if (!entry) {
      findings.push({
        driftClass: "missing_on_chain_value",
        feedId: record.feedId,
        kind: record.kind,
        txHash: record.txHash,
        local: record,
        detail: `Backend recorded a ${record.kind} for ${record.feedId} in tx ${record.txHash} but no matching on-chain write was found`,
        autoRepairable: false,
      });
      continue;
    }
    matchedKeys.add(key);

    if (normaliseValue(entry.value) !== normaliseValue(record.value)) {
      findings.push({
        driftClass: "value_mismatch",
        feedId: record.feedId,
        kind: record.kind,
        txHash: record.txHash,
        local: record,
        onChain: entry,
        detail: `Local ${record.kind} value ${record.value} differs from on-chain value ${entry.value}`,
        autoRepairable: false,
      });
      continue;
    }

    const skew = Math.abs(entry.ledgerClosedAt - record.publishedAt);
    if (skew > opts.timestampToleranceSeconds) {
      findings.push({
        driftClass: "timestamp_mismatch",
        feedId: record.feedId,
        kind: record.kind,
        txHash: record.txHash,
        local: record,
        onChain: entry,
        detail: `Local publish time differs from ledger close time by ${skew}s (tolerance ${opts.timestampToleranceSeconds}s)`,
        autoRepairable: false,
      });
    }
  }

  for (const [key, entry] of chainByKey) {
    if (matchedKeys.has(key) || localKeys.has(key)) continue;

    const writerKnown = opts.authorizedWriters.size === 0 || (entry.submitter !== undefined && opts.authorizedWriters.has(entry.submitter));
    if (!writerKnown) {
      findings.push({
        driftClass: "unexpected_writer",
        feedId: entry.feedId,
        kind: entry.kind,
        txHash: entry.txHash,
        onChain: entry,
        detail: `On-chain ${entry.kind} for ${entry.feedId} was written by ${entry.submitter ?? "an unknown submitter"}, which is not an authorised oracle writer`,
        autoRepairable: false,
      });
      continue;
    }

    findings.push({
      driftClass: "missing_local_receipt",
      feedId: entry.feedId,
      kind: entry.kind,
      txHash: entry.txHash,
      onChain: entry,
      detail: `On-chain ${entry.kind} for ${entry.feedId} in tx ${entry.txHash} has no local receipt`,
      // Only readings are backfilled. Decisions feed payouts, so a missing
      // decision receipt always goes to a human.
      autoRepairable: entry.kind === "reading",
    });
  }

  return findings;
}

function normaliseValue(value: string): string {
  try {
    return BigInt(value.trim()).toString();
  } catch {
    return value.trim();
  }
}

/** Builds the receipt the reconciler writes when backfilling from chain. */
export function receiptFromChain(entry: OnChainOracleEntry): LocalPublishRecord {
  return {
    feedId: entry.feedId,
    kind: entry.kind,
    value: entry.value,
    publishedAt: entry.ledgerClosedAt,
    txHash: entry.txHash,
    submitter: entry.submitter ?? "unknown",
    source: "reconciliation_backfill",
  };
}
