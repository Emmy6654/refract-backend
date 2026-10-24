import { z } from "zod";

const boolFromEnv = z
  .string()
  .optional()
  .transform((v) => (v === undefined ? undefined : ["1", "true", "yes", "on"].includes(v.trim().toLowerCase())));

const csv = z
  .string()
  .optional()
  .transform((v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean));

const int = (def: number, min: number) => z.coerce.number().int().min(min).default(def);

/**
 * Environment-driven configuration for the oracle chain reconciler.
 * Validated once at startup; an invalid value fails boot instead of
 * silently running with a nonsense window.
 */
export const chainReconciliationEnvSchema = z
  .object({
    ORACLE_RECONCILIATION_ENABLED: boolFromEnv,
    ORACLE_RECONCILIATION_INTERVAL_SECONDS: int(300, 10),
    ORACLE_RECONCILIATION_LOOKBACK_SECONDS: int(3600, 60),
    ORACLE_RECONCILIATION_FINALITY_BUFFER_SECONDS: int(30, 0),
    ORACLE_RECONCILIATION_TIMESTAMP_TOLERANCE_SECONDS: int(10, 0),
    ORACLE_RECONCILIATION_MAX_ENTRIES: int(500, 1),
    ORACLE_RECONCILIATION_PAGE_SIZE: int(100, 1),
    ORACLE_RECONCILIATION_SAMPLE_SIZE: int(20, 0),
    ORACLE_RECONCILIATION_LEASE_TTL_SECONDS: int(600, 10),
    ORACLE_RECONCILIATION_AUTHORIZED_WRITERS: csv,
    ORACLE_CONTRACT_ID: z.string().trim().optional(),
  })
  .refine((e) => e.ORACLE_RECONCILIATION_FINALITY_BUFFER_SECONDS < e.ORACLE_RECONCILIATION_LOOKBACK_SECONDS, {
    message: "ORACLE_RECONCILIATION_FINALITY_BUFFER_SECONDS must be smaller than ORACLE_RECONCILIATION_LOOKBACK_SECONDS",
  });

export interface ChainReconciliationConfig {
  enabled: boolean;
  intervalSeconds: number;
  lookbackSeconds: number;
  finalityBufferSeconds: number;
  timestampToleranceSeconds: number;
  /** Hard cap on on-chain entries read per run, so reconciliation cannot starve publishing. */
  maxEntriesPerRun: number;
  pageSize: number;
  sampleSize: number;
  leaseTtlSeconds: number;
  authorizedWriters: string[];
  oracleContractId?: string;
}

export const CHAIN_RECONCILIATION_CONFIG = Symbol("CHAIN_RECONCILIATION_CONFIG");

export function loadChainReconciliationConfig(env: NodeJS.ProcessEnv = process.env): ChainReconciliationConfig {
  const parsed = chainReconciliationEnvSchema.parse(env);
  return {
    // Defaults on only when there is a contract to read from.
    enabled: parsed.ORACLE_RECONCILIATION_ENABLED ?? Boolean(parsed.ORACLE_CONTRACT_ID),
    intervalSeconds: parsed.ORACLE_RECONCILIATION_INTERVAL_SECONDS,
    lookbackSeconds: parsed.ORACLE_RECONCILIATION_LOOKBACK_SECONDS,
    finalityBufferSeconds: parsed.ORACLE_RECONCILIATION_FINALITY_BUFFER_SECONDS,
    timestampToleranceSeconds: parsed.ORACLE_RECONCILIATION_TIMESTAMP_TOLERANCE_SECONDS,
    maxEntriesPerRun: parsed.ORACLE_RECONCILIATION_MAX_ENTRIES,
    pageSize: Math.min(parsed.ORACLE_RECONCILIATION_PAGE_SIZE, parsed.ORACLE_RECONCILIATION_MAX_ENTRIES),
    sampleSize: parsed.ORACLE_RECONCILIATION_SAMPLE_SIZE,
    leaseTtlSeconds: parsed.ORACLE_RECONCILIATION_LEASE_TTL_SECONDS,
    authorizedWriters: parsed.ORACLE_RECONCILIATION_AUTHORIZED_WRITERS,
    oracleContractId: parsed.ORACLE_CONTRACT_ID || undefined,
  };
}
