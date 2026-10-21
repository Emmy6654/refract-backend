export type Severity = "low" | "medium" | "high" | "triggered";

export interface OracleReading {
  readingId?: string;
  coverageType: string;
  type: "oracle_update";
  value: number;
  threshold: number;
  severity: Severity;
  message: string;
  source?: string;
  timestamp?: number;
  /**
   * True when this reading came from the fail-safe fallback (upstream outage).
   * OraclePublisherService must never publish degraded readings on-chain.
   */
  degraded?: boolean;
}
