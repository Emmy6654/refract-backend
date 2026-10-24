/**
 * Pure rules for relayer balance monitoring: how much XLM the relayer can
 * actually spend, how long that lasts at the current fee spend, and which
 * alert tier that puts us in. No I/O, so every rule is unit-testable.
 */

/** Stellar base reserve: 0.5 XLM per entry. */
export const BASE_RESERVE_STROOPS = 5_000_000n;
export const STROOPS_PER_XLM = 10_000_000n;

/** Account fields from Horizon that decide how much is spendable. */
export interface RelayerAccountSnapshot {
  balanceStroops: bigint;
  /** Native balance locked by open sell offers. */
  sellingLiabilitiesStroops: bigint;
  subentryCount: number;
  numSponsoring: number;
  numSponsored: number;
}

/** Rolling fee-spend statistics for transactions the relayer paid for. */
export interface FeeSpendSummary {
  count: number;
  totalStroops: bigint;
  avgStroops: number;
  maxStroops: bigint;
  /** Fee spend per hour over the observed window, in stroops. */
  ratePerHourStroops: number;
}

export interface BalanceThresholds {
  warningStroops: bigint;
  criticalStroops: bigint;
  warningRunwayHours: number;
  criticalRunwayHours: number;
  warningRunwaySubmissions: number;
  criticalRunwaySubmissions: number;
  /**
   * Fee assumed for the next submission when no history exists yet. The
   * relayer is `exhausted` once it cannot cover the larger of this and the
   * biggest fee seen in the window.
   */
  minSubmissionFeeStroops: bigint;
}

export type BalanceAlertTier = "ok" | "warning" | "critical" | "exhausted";

/** Ordered from best to worst; index doubles as the metric value. */
export const TIER_ORDER: readonly BalanceAlertTier[] = ["ok", "warning", "critical", "exhausted"];

export function tierRank(tier: BalanceAlertTier): number {
  return TIER_ORDER.indexOf(tier);
}

export interface BalanceAssessment {
  tier: BalanceAlertTier;
  balanceStroops: bigint;
  reserveStroops: bigint;
  spendableStroops: bigint;
  /** Fee the next submission is expected to need. */
  nextFeeStroops: bigint;
  /** Submissions left at the average fee; null without fee history. */
  runwaySubmissions: number | null;
  /** Hours left at the current spend rate; null without fee history. */
  runwayHours: number | null;
  /** Human-readable reasons for the tier, worst first. */
  reasons: string[];
}

/** Minimum balance Stellar requires the account to keep: (2 + entries) × base reserve. */
export function minimumReserveStroops(s: RelayerAccountSnapshot): bigint {
  const entries = 2 + s.subentryCount + s.numSponsoring - s.numSponsored;
  return BigInt(Math.max(entries, 0)) * BASE_RESERVE_STROOPS;
}

/** Balance available for fees after the reserve and open-offer liabilities. */
export function spendableStroops(s: RelayerAccountSnapshot): bigint {
  const spendable = s.balanceStroops - minimumReserveStroops(s) - s.sellingLiabilitiesStroops;
  return spendable > 0n ? spendable : 0n;
}

export function formatXlm(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / STROOPS_PER_XLM;
  const frac = (abs % STROOPS_PER_XLM).toString().padStart(7, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""} XLM`;
}

/** Parse a decimal XLM amount (e.g. Horizon's "123.4567890") into stroops without float rounding. */
export function parseXlmToStroops(amount: string): bigint {
  const match = /^(-)?(\d+)(?:\.(\d{1,7}))?$/.exec(amount.trim());
  if (!match) {
    throw new Error(`Invalid XLM amount: "${amount}"`);
  }
  const [, sign, whole, frac = ""] = match;
  const stroops = BigInt(whole) * STROOPS_PER_XLM + BigInt(frac.padEnd(7, "0"));
  return sign ? -stroops : stroops;
}

/** Decide the alert tier for the current balance and spend. */
export function assessBalance(
  snapshot: RelayerAccountSnapshot,
  spend: FeeSpendSummary,
  t: BalanceThresholds
): BalanceAssessment {
  const reserve = minimumReserveStroops(snapshot);
  const spendable = spendableStroops(snapshot);
  const nextFee = spend.maxStroops > t.minSubmissionFeeStroops ? spend.maxStroops : t.minSubmissionFeeStroops;

  const runwaySubmissions = spend.count > 0 && spend.avgStroops > 0 ? Number(spendable) / spend.avgStroops : null;
  const runwayHours = spend.ratePerHourStroops > 0 ? Number(spendable) / spend.ratePerHourStroops : null;

  const reasons: Array<{ tier: BalanceAlertTier; text: string }> = [];
  const add = (tier: BalanceAlertTier, text: string) => reasons.push({ tier, text });

  if (spendable < nextFee) {
    add("exhausted", `spendable ${formatXlm(spendable)} cannot cover the next fee of ${formatXlm(nextFee)}`);
  }
  if (spendable < t.criticalStroops) {
    add("critical", `spendable ${formatXlm(spendable)} is below ${formatXlm(t.criticalStroops)}`);
  } else if (spendable < t.warningStroops) {
    add("warning", `spendable ${formatXlm(spendable)} is below ${formatXlm(t.warningStroops)}`);
  }
  if (runwayHours !== null) {
    if (runwayHours < t.criticalRunwayHours) add("critical", `about ${runwayHours.toFixed(1)}h of fees left at the current rate`);
    else if (runwayHours < t.warningRunwayHours) add("warning", `about ${runwayHours.toFixed(1)}h of fees left at the current rate`);
  }
  if (runwaySubmissions !== null) {
    if (runwaySubmissions < t.criticalRunwaySubmissions) {
      add("critical", `about ${Math.floor(runwaySubmissions)} submissions left at the average fee`);
    } else if (runwaySubmissions < t.warningRunwaySubmissions) {
      add("warning", `about ${Math.floor(runwaySubmissions)} submissions left at the average fee`);
    }
  }

  reasons.sort((a, b) => tierRank(b.tier) - tierRank(a.tier));
  return {
    tier: reasons[0]?.tier ?? "ok",
    balanceStroops: snapshot.balanceStroops,
    reserveStroops: reserve,
    spendableStroops: spendable,
    nextFeeStroops: nextFee,
    runwaySubmissions,
    runwayHours,
    reasons: reasons.map((r) => r.text),
  };
}

export type AlertDecision =
  | { emit: false }
  | { emit: true; kind: "escalated" | "recovered" | "reminder"; severity: "info" | "warning" | "critical" };

/**
 * When to alert: on every escalation, once on recovery, and as a reminder
 * every `renotifyMs` while the tier stays above ok.
 */
export function decideAlert(
  previous: BalanceAlertTier,
  next: BalanceAlertTier,
  lastAlertAt: number | null,
  now: number,
  renotifyMs: number
): AlertDecision {
  const severity = next === "warning" ? "warning" : "critical";
  if (tierRank(next) > tierRank(previous)) {
    return { emit: true, kind: "escalated", severity };
  }
  if (tierRank(next) < tierRank(previous)) {
    return next === "ok"
      ? { emit: true, kind: "recovered", severity: "info" }
      : { emit: true, kind: "recovered", severity };
  }
  if (next !== "ok" && (lastAlertAt === null || now - lastAlertAt >= renotifyMs)) {
    return { emit: true, kind: "reminder", severity };
  }
  return { emit: false };
}
