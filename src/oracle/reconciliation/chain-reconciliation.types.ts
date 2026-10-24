/**
 * Shared types for backend-to-chain oracle reconciliation (issue #219).
 *
 * The reconciler answers one question continuously: "does the chain actually
 * hold what we think we published?" It compares the backend's publish
 * receipts against oracle state read back from Soroban and classifies every
 * difference into one of the drift classes below.
 */

/** A published oracle value is either a raw reading or a consensus decision. */
export type PublishKind = "reading" | "decision";

/**
 * The backend's record (receipt) of something it published on-chain.
 * Written by the publisher after a submission confirms, or by the
 * reconciler when it backfills a receipt that was lost.
 */
export interface LocalPublishRecord {
  /** Feed identifier, e.g. the coverage type name ("StablecoinDepeg"). */
  feedId: string;
  kind: PublishKind;
  /** Fixed-point i128 value as a decimal string (see oracle-encoding.ts). */
  value: string;
  /** Unix seconds the value was published (ledger close time when known). */
  publishedAt: number;
  /** Soroban transaction hash that carried the write. */
  txHash: string;
  /** Account that submitted the transaction (the relayer public key). */
  submitter: string;
  /** Where this receipt came from. */
  source: "publisher" | "reconciliation_backfill";
}

/** One oracle write observed on-chain. */
export interface OnChainOracleEntry {
  feedId: string;
  kind: PublishKind;
  value: string;
  ledger: number;
  /** Unix seconds of the ledger close. */
  ledgerClosedAt: number;
  txHash: string;
  /** Submitter as recorded by the contract event, when the event carries it. */
  submitter?: string;
  /** RPC event id, kept for audit sampling. */
  eventId?: string;
}

export const DRIFT_CLASSES = [
  "missing_local_receipt",
  "missing_on_chain_value",
  "value_mismatch",
  "timestamp_mismatch",
  "unexpected_writer",
] as const;

export type DriftClass = (typeof DRIFT_CLASSES)[number];

export interface DriftFinding {
  driftClass: DriftClass;
  feedId: string;
  kind: PublishKind;
  txHash: string;
  local?: LocalPublishRecord;
  onChain?: OnChainOracleEntry;
  detail: string;
  /**
   * True only for drift the reconciler may fix by itself. Today that is a
   * missing local receipt for a *reading*: the chain is the source of truth
   * and the backend simply lost its copy. Decision records are never
   * rewritten automatically.
   */
  autoRepairable: boolean;
}

export type DriftCounts = Record<DriftClass, number>;

export function emptyDriftCounts(): DriftCounts {
  return DRIFT_CLASSES.reduce((acc, c) => ({ ...acc, [c]: 0 }), {} as DriftCounts);
}

export type ReconciliationRunStatus = "completed" | "failed";

/** Auditable record of one reconciliation pass. */
export interface ReconciliationRun {
  id: string;
  trigger: "scheduled" | "manual";
  status: ReconciliationRunStatus;
  startedAt: number;
  finishedAt: number;
  /** Window that was compared, in unix seconds (inclusive). */
  windowStart: number;
  windowEnd: number;
  localRecordsCompared: number;
  onChainEntriesCompared: number;
  /** True when the on-chain read hit `maxEntriesPerRun` and was cut short. */
  onChainReadTruncated: boolean;
  counts: DriftCounts;
  repaired: number;
  /** Findings left for a human (everything not auto-repaired). */
  pendingReview: number;
  /** Bounded sample of findings, for audit without unbounded storage. */
  sampledFindings: DriftFinding[];
  error?: string;
}
