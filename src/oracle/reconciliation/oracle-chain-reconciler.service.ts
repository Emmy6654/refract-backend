import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { AlertingService, AlertSeverity } from "../../alerting/alerting.service";
import { MetricsService } from "../../metrics/metrics.service";
import { diffChainState, diffWindow, receiptFromChain } from "./chain-diff";
import { CHAIN_RECONCILIATION_CONFIG, ChainReconciliationConfig } from "./chain-reconciliation.config";
import {
  DRIFT_CLASSES,
  DriftClass,
  DriftFinding,
  emptyDriftCounts,
  ReconciliationRun,
} from "./chain-reconciliation.types";
import { RECONCILIATION_LEASE, ReconciliationLease } from "./reconciliation-lease";
import {
  CHAIN_ORACLE_STATE_READER,
  ChainOracleStateReader,
  ORACLE_PUBLISH_LEDGER,
  OraclePublishLedger,
  RECONCILIATION_RUN_STORE,
  ReconciliationRunStore,
} from "./reconciliation.stores";

const LEASE_NAME = "oracle-chain-reconciliation";

/** Alert severity per drift class. Anything that could affect payouts is critical. */
const ALERT_SEVERITY: Record<DriftClass, AlertSeverity> = {
  missing_local_receipt: "warning",
  missing_on_chain_value: "critical",
  value_mismatch: "critical",
  timestamp_mismatch: "warning",
  unexpected_writer: "critical",
};

export type ReconcileOutcome = { skipped: true; reason: "lease_held" | "disabled" } | { skipped: false; run: ReconciliationRun };

/**
 * Periodic backend-to-chain reconciliation for published oracle readings and
 * decisions (issue #219).
 *
 * Each run:
 *  1. takes a lease so only one replica reconciles at a time;
 *  2. reads recent oracle writes from Soroban (bounded by maxEntriesPerRun);
 *  3. diffs them against local publish receipts over the lookback window,
 *     ignoring anything inside the finality buffer;
 *  4. backfills missing *reading* receipts (the only safe repair) and leaves
 *     everything else — in particular any decision record and any value
 *     mismatch — for human review;
 *  5. emits metrics and alerts per drift class and stores a run record.
 */
@Injectable()
export class OracleChainReconcilerService {
  private readonly logger = new Logger(OracleChainReconcilerService.name);
  private readonly ownerId = `reconciler-${randomUUID()}`;

  constructor(
    @Inject(CHAIN_RECONCILIATION_CONFIG) private readonly config: ChainReconciliationConfig,
    @Inject(CHAIN_ORACLE_STATE_READER) private readonly chain: ChainOracleStateReader,
    @Inject(ORACLE_PUBLISH_LEDGER) private readonly ledger: OraclePublishLedger,
    @Inject(RECONCILIATION_RUN_STORE) private readonly runs: ReconciliationRunStore,
    @Inject(RECONCILIATION_LEASE) private readonly lease: ReconciliationLease,
    private readonly alerting: AlertingService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() @Inject("RECONCILER_CLOCK") private readonly now: () => number = Date.now,
  ) {}

  async reconcile(trigger: ReconciliationRun["trigger"] = "scheduled"): Promise<ReconcileOutcome> {
    if (!this.config.enabled) return { skipped: true, reason: "disabled" };

    const acquired = await this.lease.acquire(LEASE_NAME, this.ownerId, this.config.leaseTtlSeconds * 1000);
    if (!acquired) {
      this.logger.debug("Reconciliation lease held by another runner — skipping this tick");
      return { skipped: true, reason: "lease_held" };
    }

    try {
      const run = await this.runOnce(trigger);
      return { skipped: false, run };
    } finally {
      await this.lease.release(LEASE_NAME, this.ownerId).catch((err: unknown) => {
        this.logger.warn(`Failed to release reconciliation lease: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  listRuns(limit = 20): Promise<ReconciliationRun[]> {
    return this.runs.listRecent(limit);
  }

  private async runOnce(trigger: ReconciliationRun["trigger"]): Promise<ReconciliationRun> {
    const startedAt = this.now();
    const nowSec = Math.floor(startedAt / 1000);
    const diffOpts = {
      nowSec,
      lookbackSeconds: this.config.lookbackSeconds,
      finalityBufferSeconds: this.config.finalityBufferSeconds,
      timestampToleranceSeconds: this.config.timestampToleranceSeconds,
      authorizedWriters: new Set(this.config.authorizedWriters),
    };
    const window = diffWindow(diffOpts);
    const base: ReconciliationRun = {
      id: randomUUID(),
      trigger,
      status: "completed",
      startedAt,
      finishedAt: startedAt,
      windowStart: window.start,
      windowEnd: window.end,
      localRecordsCompared: 0,
      onChainEntriesCompared: 0,
      onChainReadTruncated: false,
      counts: emptyDriftCounts(),
      repaired: 0,
      pendingReview: 0,
      sampledFindings: [],
    };

    let run: ReconciliationRun;
    try {
      const [{ entries, truncated }, local] = await Promise.all([
        this.chain.readSince(window.start, this.config.maxEntriesPerRun),
        this.ledger.listPublishedBetween(window.start, window.end),
      ]);

      const findings = diffChainState(local, entries, diffOpts);
      const repaired = await this.repair(findings);

      const counts = emptyDriftCounts();
      for (const f of findings) counts[f.driftClass]++;

      run = {
        ...base,
        finishedAt: this.now(),
        localRecordsCompared: local.length,
        onChainEntriesCompared: entries.length,
        onChainReadTruncated: truncated,
        counts,
        repaired,
        pendingReview: findings.length - repaired,
        sampledFindings: sampleFindings(findings, this.config.sampleSize),
      };

      if (truncated) {
        this.alerting.emit(
          "warning",
          "Oracle reconciliation read truncated",
          `On-chain read stopped at ${this.config.maxEntriesPerRun} events; older entries in the window were not compared. Raise ORACLE_RECONCILIATION_MAX_ENTRIES or shorten the lookback.`,
          { runId: run.id },
        );
      }
      this.alertOnDrift(run, findings);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Oracle chain reconciliation failed: ${message}`);
      run = { ...base, status: "failed", finishedAt: this.now(), error: message };
      this.alerting.emit("warning", "Oracle reconciliation failed", message, { runId: run.id });
    }

    await this.runs.save(run).catch((err: unknown) => {
      this.logger.error(`Failed to persist reconciliation run ${run.id}: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.metrics?.recordOracleReconciliationRun(run.status === "completed" ? "success" : "failure", (run.finishedAt - run.startedAt) / 1000, run.counts, run.repaired);

    this.logger.log(
      `Oracle reconciliation ${run.status}: compared ${run.localRecordsCompared} local / ${run.onChainEntriesCompared} on-chain, ` +
        `drift=${JSON.stringify(run.counts)} repaired=${run.repaired} pendingReview=${run.pendingReview}`,
    );
    return run;
  }

  /**
   * Applies the only safe automatic repair: backfill a missing local receipt
   * for a reading from the chain (the chain is authoritative). Everything
   * else is left untouched for review.
   */
  private async repair(findings: DriftFinding[]): Promise<number> {
    let repaired = 0;
    for (const finding of findings) {
      if (!finding.autoRepairable || !finding.onChain) continue;
      if (finding.driftClass !== "missing_local_receipt" || finding.kind !== "reading") continue;
      try {
        await this.ledger.recordReceipt(receiptFromChain(finding.onChain));
        // Counted as repaired even if a concurrent run inserted it first —
        // either way the receipt now exists.
        repaired++;
      } catch (err) {
        this.logger.warn(`Backfill failed for ${finding.txHash}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return repaired;
  }

  private alertOnDrift(run: ReconciliationRun, findings: DriftFinding[]): void {
    for (const driftClass of DRIFT_CLASSES) {
      const count = run.counts[driftClass];
      if (count === 0) continue;
      const examples = findings.filter((f) => f.driftClass === driftClass).slice(0, 3);
      const autoRepaired = driftClass === "missing_local_receipt" ? examples.every((f) => f.autoRepairable) : false;
      this.alerting.emit(
        autoRepaired ? "info" : ALERT_SEVERITY[driftClass],
        `Oracle drift: ${driftClass}`,
        `${count} ${driftClass} finding(s) in reconciliation run ${run.id}${autoRepaired ? " (auto-repaired)" : " — review required"}`,
        { runId: run.id, examples: examples.map((f) => ({ feedId: f.feedId, kind: f.kind, txHash: f.txHash, detail: f.detail })) },
      );
    }
  }
}

/** Keeps at least one example of every drift class before filling the rest. */
function sampleFindings(findings: DriftFinding[], size: number): DriftFinding[] {
  if (findings.length <= size) return findings;
  const sample: DriftFinding[] = [];
  const seen = new Set<DriftClass>();
  for (const f of findings) {
    if (sample.length >= size) break;
    if (!seen.has(f.driftClass)) {
      seen.add(f.driftClass);
      sample.push(f);
    }
  }
  for (const f of findings) {
    if (sample.length >= size) break;
    if (!sample.includes(f)) sample.push(f);
  }
  return sample;
}
