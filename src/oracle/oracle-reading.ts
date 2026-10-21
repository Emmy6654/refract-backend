export type Severity = "low" | "medium" | "high" | "triggered";

export interface OracleReading {
  coverageType: string;
  type: "oracle_update";
  value: number;
  threshold: number;
  severity: Severity;
  message: string;
  feedId?: string;
  observedAt?: number;
  deadlineAt?: number;
  fetchDurationMs?: number;
  /**
   * True when this reading came from the fail-safe fallback (upstream outage).
   * OraclePublisherService must never publish degraded readings on-chain.
   */
  degraded?: boolean;
}
