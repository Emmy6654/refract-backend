export type Severity = "low" | "medium" | "high" | "triggered";

export interface OracleEvidenceMetadata {
  adapter: string;
  schemaVersion: number;
  digest: string;
  attribution: string;
  sensitivity: "public" | "commercial" | "personal" | "synthetic";
}

export interface OracleReading {
  coverageType: string;
  type: "oracle_update";
  value: number;
  threshold: number;
  severity: Severity;
  message: string;
  adapter?: string;
  schemaVersion?: number;
  evidenceRoot?: string;
  attestation?: string;
  attribution?: string;
  evidence?: OracleEvidenceMetadata[];
  /**
   * True when this reading came from the fail-safe fallback (upstream outage).
   * OraclePublisherService must never publish degraded readings on-chain.
   */
  degraded?: boolean;
}
