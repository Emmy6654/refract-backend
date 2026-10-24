import { FeeSpendSummary } from "./relayer-balance.policy";

export interface FeeSpendRecord {
  txHash: string;
  feeChargedStroops: bigint;
  /** Ledger close time of the transaction (epoch ms). */
  at: number;
  successful: boolean;
}

/**
 * Rolling window of fees the relayer actually paid, one record per
 * submitted transaction (oracle publishes and claim settlements share the
 * relayer key). Failed transactions are kept: they still cost a fee.
 */
export class FeeSpendTracker {
  private readonly records = new Map<string, FeeSpendRecord>();

  /**
   * @param windowMs how far back the summary looks
   * @param minRateSpanMs lower bound on the span used for the hourly rate,
   *   so a burst right after startup is not extrapolated into a huge rate
   */
  constructor(
    private readonly windowMs: number,
    private readonly minRateSpanMs = 15 * 60_000
  ) {}

  /** Adds a record; returns false if the transaction was already counted. */
  record(r: FeeSpendRecord): boolean {
    if (this.records.has(r.txHash)) return false;
    this.records.set(r.txHash, r);
    return true;
  }

  summary(now: number): FeeSpendSummary {
    this.prune(now);
    const inWindow = [...this.records.values()];
    if (inWindow.length === 0) {
      return { count: 0, totalStroops: 0n, avgStroops: 0, maxStroops: 0n, ratePerHourStroops: 0 };
    }
    let total = 0n;
    let max = 0n;
    let oldest = Infinity;
    for (const r of inWindow) {
      total += r.feeChargedStroops;
      if (r.feeChargedStroops > max) max = r.feeChargedStroops;
      if (r.at < oldest) oldest = r.at;
    }
    const spanMs = Math.min(Math.max(now - oldest, this.minRateSpanMs), this.windowMs);
    return {
      count: inWindow.length,
      totalStroops: total,
      avgStroops: Number(total) / inWindow.length,
      maxStroops: max,
      ratePerHourStroops: (Number(total) / spanMs) * 3_600_000,
    };
  }

  private prune(now: number): void {
    for (const [hash, r] of this.records) {
      if (now - r.at > this.windowMs) this.records.delete(hash);
    }
  }
}
