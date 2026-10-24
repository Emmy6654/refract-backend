import { publishKey } from "./chain-diff";
import { LocalPublishRecord, OnChainOracleEntry, ReconciliationRun } from "./chain-reconciliation.types";

/**
 * The backend's ledger of what it published. The publisher records a
 * receipt after each confirmed submission; the reconciler reads receipts
 * back and backfills ones that were lost.
 */
export interface OraclePublishLedger {
  listPublishedBetween(fromSec: number, toSec: number): Promise<LocalPublishRecord[]>;
  /**
   * Idempotent: returns false (and changes nothing) when a receipt for the
   * same (txHash, kind, feedId) already exists, so two concurrent runs can
   * never double-insert.
   */
  recordReceipt(record: LocalPublishRecord): Promise<boolean>;
}

/** Reads oracle writes back from the chain. */
export interface ChainOracleStateReader {
  /**
   * Returns oracle writes whose ledger closed at or after `sinceSec`, oldest
   * first, stopping after `maxEntries`. `truncated` is true when more
   * entries existed than were returned.
   */
  readSince(sinceSec: number, maxEntries: number): Promise<{ entries: OnChainOracleEntry[]; truncated: boolean }>;
}

export interface ReconciliationRunStore {
  save(run: ReconciliationRun): Promise<void>;
  listRecent(limit: number): Promise<ReconciliationRun[]>;
}

export const ORACLE_PUBLISH_LEDGER = Symbol("ORACLE_PUBLISH_LEDGER");
export const CHAIN_ORACLE_STATE_READER = Symbol("CHAIN_ORACLE_STATE_READER");
export const RECONCILIATION_RUN_STORE = Symbol("RECONCILIATION_RUN_STORE");

export class InMemoryOraclePublishLedger implements OraclePublishLedger {
  private readonly records = new Map<string, LocalPublishRecord>();

  async listPublishedBetween(fromSec: number, toSec: number): Promise<LocalPublishRecord[]> {
    return [...this.records.values()].filter((r) => r.publishedAt >= fromSec && r.publishedAt <= toSec);
  }

  async recordReceipt(record: LocalPublishRecord): Promise<boolean> {
    const key = publishKey(record);
    if (this.records.has(key)) return false;
    this.records.set(key, { ...record });
    return true;
  }
}

export class InMemoryReconciliationRunStore implements ReconciliationRunStore {
  private readonly runs: ReconciliationRun[] = [];

  constructor(private readonly capacity = 200) {}

  async save(run: ReconciliationRun): Promise<void> {
    this.runs.unshift(run);
    if (this.runs.length > this.capacity) this.runs.length = this.capacity;
  }

  async listRecent(limit: number): Promise<ReconciliationRun[]> {
    return this.runs.slice(0, limit);
  }
}

/** Minimal `pg` surface so Postgres stores can be tested without a database. */
export interface Queryable {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount?: number | null }>;
}

/** Postgres-backed publish ledger over `oracle_publish_receipts` (src/db/migrations/004_oracle_chain_reconciliation.sql). */
export class PgOraclePublishLedger implements OraclePublishLedger {
  constructor(private readonly db: Queryable) {}

  async listPublishedBetween(fromSec: number, toSec: number): Promise<LocalPublishRecord[]> {
    const { rows } = await this.db.query<{
      feed_id: string;
      kind: LocalPublishRecord["kind"];
      value: string;
      published_at: string | number;
      tx_hash: string;
      submitter: string;
      source: LocalPublishRecord["source"];
    }>(
      `SELECT feed_id, kind, value::text AS value, EXTRACT(EPOCH FROM published_at)::bigint AS published_at,
              tx_hash, submitter, source
         FROM oracle_publish_receipts
        WHERE published_at BETWEEN to_timestamp($1) AND to_timestamp($2)`,
      [fromSec, toSec],
    );
    return rows.map((r) => ({
      feedId: r.feed_id,
      kind: r.kind,
      value: r.value,
      publishedAt: Number(r.published_at),
      txHash: r.tx_hash,
      submitter: r.submitter,
      source: r.source,
    }));
  }

  async recordReceipt(record: LocalPublishRecord): Promise<boolean> {
    const result = await this.db.query(
      `INSERT INTO oracle_publish_receipts (feed_id, kind, value, published_at, tx_hash, submitter, source)
       VALUES ($1, $2, $3::numeric, to_timestamp($4), $5, $6, $7)
       ON CONFLICT (tx_hash, kind, feed_id) DO NOTHING`,
      [record.feedId, record.kind, record.value, record.publishedAt, record.txHash, record.submitter, record.source],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

/** Postgres-backed run store over `oracle_reconciliation_runs`. */
export class PgReconciliationRunStore implements ReconciliationRunStore {
  constructor(private readonly db: Queryable) {}

  async save(run: ReconciliationRun): Promise<void> {
    await this.db.query(
      `INSERT INTO oracle_reconciliation_runs
         (id, trigger, status, started_at, finished_at, window_start, window_end,
          local_records_compared, on_chain_entries_compared, on_chain_read_truncated,
          drift_counts, repaired, pending_review, sampled_findings, error)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), to_timestamp($5 / 1000.0), to_timestamp($6), to_timestamp($7),
               $8, $9, $10, $11::jsonb, $12, $13, $14::jsonb, $15)`,
      [
        run.id,
        run.trigger,
        run.status,
        run.startedAt,
        run.finishedAt,
        run.windowStart,
        run.windowEnd,
        run.localRecordsCompared,
        run.onChainEntriesCompared,
        run.onChainReadTruncated,
        JSON.stringify(run.counts),
        run.repaired,
        run.pendingReview,
        JSON.stringify(run.sampledFindings),
        run.error ?? null,
      ],
    );
  }

  async listRecent(limit: number): Promise<ReconciliationRun[]> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT id, trigger, status,
              (EXTRACT(EPOCH FROM started_at) * 1000)::bigint AS started_at,
              (EXTRACT(EPOCH FROM finished_at) * 1000)::bigint AS finished_at,
              EXTRACT(EPOCH FROM window_start)::bigint AS window_start,
              EXTRACT(EPOCH FROM window_end)::bigint AS window_end,
              local_records_compared, on_chain_entries_compared, on_chain_read_truncated,
              drift_counts, repaired, pending_review, sampled_findings, error
         FROM oracle_reconciliation_runs
        ORDER BY started_at DESC
        LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      id: String(r.id),
      trigger: r.trigger as ReconciliationRun["trigger"],
      status: r.status as ReconciliationRun["status"],
      startedAt: Number(r.started_at),
      finishedAt: Number(r.finished_at),
      windowStart: Number(r.window_start),
      windowEnd: Number(r.window_end),
      localRecordsCompared: Number(r.local_records_compared),
      onChainEntriesCompared: Number(r.on_chain_entries_compared),
      onChainReadTruncated: Boolean(r.on_chain_read_truncated),
      counts: r.drift_counts as ReconciliationRun["counts"],
      repaired: Number(r.repaired),
      pendingReview: Number(r.pending_review),
      sampledFindings: r.sampled_findings as ReconciliationRun["sampledFindings"],
      error: (r.error as string | null) ?? undefined,
    }));
  }
}
