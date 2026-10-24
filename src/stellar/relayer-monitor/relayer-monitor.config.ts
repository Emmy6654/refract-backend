import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { BalanceThresholds, parseXlmToStroops } from "./relayer-balance.policy";

export interface RelayerMonitorConfig {
  enabled: boolean;
  /** Why monitoring is off, when it is. */
  disabledReason?: string;
  publicKey: string | null;
  horizonUrl: string;
  intervalMs: number;
  feeWindowMs: number;
  renotifyMs: number;
  /** Consecutive failed checks before alerting that the balance is unknown. */
  failuresBeforeAlert: number;
  thresholds: BalanceThresholds;
}

const HORIZON_BY_NETWORK: Record<string, string> = {
  testnet: "https://horizon-testnet.stellar.org",
  futurenet: "https://horizon-futurenet.stellar.org",
  mainnet: "https://horizon.stellar.org",
};

function num(env: NodeJS.ProcessEnv, key: string, fallback: number, min = 0): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${key} must be a number >= ${min} (got "${raw}")`);
  }
  return value;
}

function xlm(env: NodeJS.ProcessEnv, key: string, fallback: string): bigint {
  const raw = env[key]?.trim() || fallback;
  const stroops = parseXlmToStroops(raw);
  if (stroops < 0n) throw new Error(`${key} must not be negative`);
  return stroops;
}

/**
 * The relayer's public key: RELAYER_PUBLIC_KEY if set (preferred — the
 * monitor then never needs the secret), otherwise derived from the
 * relayer secret the publisher already uses.
 */
function resolvePublicKey(env: NodeJS.ProcessEnv): string | null {
  const explicit = env.RELAYER_PUBLIC_KEY?.trim();
  if (explicit) {
    if (!StrKey.isValidEd25519PublicKey(explicit)) {
      throw new Error("RELAYER_PUBLIC_KEY must be a valid Stellar public key (G...)");
    }
    return explicit;
  }
  const secret = (env.ORACLE_RELAYER_SECRET ?? env.RELAYER_SECRET_KEY ?? "").trim();
  if (secret && StrKey.isValidEd25519SecretSeed(secret)) {
    return Keypair.fromSecret(secret).publicKey();
  }
  return null;
}

export function loadRelayerMonitorConfig(env: NodeJS.ProcessEnv = process.env): RelayerMonitorConfig {
  const network = (env.STELLAR_NETWORK ?? "testnet").trim().toLowerCase();
  const horizonUrl = env.STELLAR_HORIZON_URL?.trim() || HORIZON_BY_NETWORK[network] || HORIZON_BY_NETWORK.testnet;

  const thresholds: BalanceThresholds = {
    warningStroops: xlm(env, "RELAYER_BALANCE_WARNING_XLM", "100"),
    criticalStroops: xlm(env, "RELAYER_BALANCE_CRITICAL_XLM", "25"),
    warningRunwayHours: num(env, "RELAYER_RUNWAY_WARNING_HOURS", 72),
    criticalRunwayHours: num(env, "RELAYER_RUNWAY_CRITICAL_HOURS", 24),
    warningRunwaySubmissions: num(env, "RELAYER_RUNWAY_WARNING_SUBMISSIONS", 1_000),
    criticalRunwaySubmissions: num(env, "RELAYER_RUNWAY_CRITICAL_SUBMISSIONS", 200),
    minSubmissionFeeStroops: xlm(env, "RELAYER_MIN_SUBMISSION_FEE_XLM", "0.01"),
  };
  const pairs: Array<[string, number | bigint, number | bigint]> = [
    ["RELAYER_BALANCE", thresholds.criticalStroops, thresholds.warningStroops],
    ["RELAYER_RUNWAY_*_HOURS", thresholds.criticalRunwayHours, thresholds.warningRunwayHours],
    ["RELAYER_RUNWAY_*_SUBMISSIONS", thresholds.criticalRunwaySubmissions, thresholds.warningRunwaySubmissions],
  ];
  for (const [name, critical, warning] of pairs) {
    if (critical > warning) throw new Error(`${name}: the critical threshold must not exceed the warning threshold`);
  }

  const publicKey = resolvePublicKey(env);
  const optedOut = (env.RELAYER_MONITOR_ENABLED ?? "true").trim().toLowerCase() === "false";
  return {
    enabled: !optedOut && publicKey !== null,
    disabledReason: optedOut
      ? "RELAYER_MONITOR_ENABLED=false"
      : publicKey === null
        ? "no relayer key configured (RELAYER_PUBLIC_KEY or ORACLE_RELAYER_SECRET)"
        : undefined,
    publicKey,
    horizonUrl,
    intervalMs: num(env, "RELAYER_MONITOR_INTERVAL_MS", 60_000, 1_000),
    feeWindowMs: num(env, "RELAYER_FEE_WINDOW_HOURS", 24, 1) * 3_600_000,
    renotifyMs: num(env, "RELAYER_ALERT_RENOTIFY_MINUTES", 60, 1) * 60_000,
    failuresBeforeAlert: num(env, "RELAYER_MONITOR_FAILURES_BEFORE_ALERT", 3, 1),
    thresholds,
  };
}
