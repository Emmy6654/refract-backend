import { createHash } from "crypto";

/**
 * Multi-source oracle consensus.
 *
 * Every payout decision rests on the numbers produced here, so this module is
 * deliberately pure: no I/O, no clock reads (callers pass `now`), no Nest
 * dependencies. That keeps it easy to exercise with property-based tests
 * (see consensus.property.spec.ts).
 *
 * Pipeline for one evaluation:
 *   1. Screen each observation: malformed or duplicated sources are
 *      `invalid`, old ones are `stale`.
 *   2. Take the median of the fresh values as the screening center.
 *   3. Sources further than the deviation tolerance from the center are
 *      `outlier`s; the rest are `agreeing`.
 *   4. Agreement needs enough agreeing sources and enough agreeing weight
 *      (weighted quorum over every source that reported).
 *   5. The published value is the median of the agreeing values.
 */

/** One source's report for a single coverage type. */
export interface SourceObservation {
  /** Stable identifier of the data source (e.g. "coingecko"). */
  sourceId: string;
  /** The reported value, in the coverage type's natural unit. */
  value: number;
  /** Voting weight. Must be finite and >= 0. */
  weight: number;
  /** When the source observed the value (epoch milliseconds). */
  observedAt: number;
}

export interface ConsensusPolicy {
  /** Fraction (0, 1] of total reporting weight that must agree. */
  quorumRatio: number;
  /** Minimum number of agreeing sources (>= 1). */
  minAgreeingSources: number;
  /** Allowed deviation from the center, relative to |center| (>= 0). */
  maxDeviationRatio: number;
  /**
   * Absolute deviation that is always tolerated (>= 0). Needed when the
   * center is near zero (e.g. a 0% market move), where a purely relative
   * tolerance would reject every source.
   */
  absoluteDeviationFloor: number;
  /** Observations older than this are stale (ms, >= 0). */
  maxStalenessMs: number;
  /** Observations further in the future than this are invalid (ms, >= 0). */
  maxFutureSkewMs: number;
}

export const DEFAULT_CONSENSUS_POLICY: Readonly<ConsensusPolicy> = Object.freeze({
  quorumRatio: 2 / 3,
  minAgreeingSources: 2,
  maxDeviationRatio: 0.02,
  absoluteDeviationFloor: 0,
  maxStalenessMs: 5 * 60_000,
  maxFutureSkewMs: 30_000,
});

/**
 * How much the published value can be trusted. The numeric values are part
 * of the on-chain provenance encoding (see oracle-encoding.ts) — never
 * renumber them.
 */
export enum TrustTier {
  /** No consensus; must never be published as authoritative. */
  Unverified = 0,
  /** Exactly one source agreed (only possible when minAgreeingSources = 1). */
  SingleSource = 1,
  /** Two or more sources agreed and quorum was met. */
  Corroborated = 2,
  /** Three or more sources, all fresh, valid and in agreement. */
  Unanimous = 3,
}

export type ConsensusStatus = "agreed" | "no_valid_sources" | "insufficient_sources" | "no_quorum";

export interface ConsensusDecision {
  status: ConsensusStatus;
  /** Median of agreeing values; null unless status is "agreed". */
  value: number | null;
  trustTier: TrustTier;
  /** Deterministic 64-bit identifier of this decision, as 16 hex chars. */
  decisionId: string;
  /** Median of fresh values used to screen outliers; null if none were fresh. */
  center: number | null;
  /** Source ids by disposition. Each list is sorted and duplicate-free. */
  agreeingSources: string[];
  outlierSources: string[];
  staleSources: string[];
  invalidSources: string[];
  agreeingWeight: number;
  /** Weight of every distinct source that reported, valid or not. */
  totalWeight: number;
  /** Earliest observedAt among agreeing sources (ms); null unless agreed. */
  sourceTimestamp: number | null;
  evaluatedAt: number;
}

/** Median of a non-empty list of finite numbers. Mean of the middle pair for even lengths. */
export function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new RangeError("median() of an empty list");
  }
  for (const v of values) {
    if (!Number.isFinite(v)) {
      throw new RangeError(`median() requires finite numbers, got ${v}`);
    }
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  // (lo + hi) / 2 is correctly rounded, so it stays inside [lo, hi] even for
  // subnormals. Only when the sum overflows do we halve first — at that
  // magnitude halving is exact.
  const sum = lo + hi;
  return Number.isFinite(sum) ? sum / 2 : lo / 2 + hi / 2;
}

/** Largest distance from `center` that still counts as agreement. */
export function deviationTolerance(center: number, policy: ConsensusPolicy): number {
  return Math.max(policy.maxDeviationRatio * Math.abs(center), policy.absoluteDeviationFloor);
}

export function isAnomalous(value: number, center: number, policy: ConsensusPolicy): boolean {
  return Math.abs(value - center) > deviationTolerance(center, policy);
}

/**
 * Weighted quorum check. Uses a division rather than `ratio * total` so the
 * result does not change when every weight is scaled by the same factor.
 */
export function meetsQuorum(agreeingWeight: number, totalWeight: number, quorumRatio: number): boolean {
  if (!(totalWeight > 0) || !Number.isFinite(totalWeight) || !(agreeingWeight >= 0)) {
    return false;
  }
  return agreeingWeight / totalWeight >= quorumRatio;
}

/** Throws if the policy is unusable. Policies are operator config, so failing loudly is correct. */
export function validateConsensusPolicy(policy: ConsensusPolicy): void {
  const problems: string[] = [];
  if (!(policy.quorumRatio > 0 && policy.quorumRatio <= 1)) problems.push("quorumRatio must be in (0, 1]");
  if (!Number.isInteger(policy.minAgreeingSources) || policy.minAgreeingSources < 1) {
    problems.push("minAgreeingSources must be an integer >= 1");
  }
  for (const key of ["maxDeviationRatio", "absoluteDeviationFloor", "maxStalenessMs", "maxFutureSkewMs"] as const) {
    if (!(Number.isFinite(policy[key]) && policy[key] >= 0)) problems.push(`${key} must be finite and >= 0`);
  }
  if (problems.length > 0) {
    throw new RangeError(`Invalid consensus policy: ${problems.join("; ")}`);
  }
}

function isUsableWeight(w: unknown): w is number {
  return typeof w === "number" && Number.isFinite(w) && w >= 0;
}

/**
 * Evaluate consensus over one round of observations.
 *
 * Never throws for bad observations — they are classified as invalid. It
 * only throws for an invalid policy or a non-finite `now`.
 *
 * The result does not depend on the order of `observations`.
 */
export function evaluateConsensus(
  observations: readonly SourceObservation[],
  policy: ConsensusPolicy,
  now: number
): ConsensusDecision {
  validateConsensusPolicy(policy);
  if (!Number.isFinite(now)) {
    throw new RangeError(`evaluateConsensus() requires a finite 'now', got ${now}`);
  }

  // Group by source id. A source id that appears more than once is treated
  // as invalid in every copy, so a source cannot vote twice and the outcome
  // does not depend on which copy came first.
  const bySource = new Map<string, SourceObservation[]>();
  for (const obs of observations) {
    const id = typeof obs?.sourceId === "string" ? obs.sourceId : String(obs?.sourceId);
    const list = bySource.get(id);
    if (list) list.push(obs);
    else bySource.set(id, [obs]);
  }

  const invalid: string[] = [];
  const stale: string[] = [];
  const fresh: SourceObservation[] = [];
  let totalWeight = 0;

  for (const [id, copies] of bySource) {
    // Every source that reported counts toward the quorum denominator, so a
    // misbehaving source cannot shrink the bar by sending garbage.
    const usableWeights = copies.map((c) => c.weight).filter(isUsableWeight);
    if (usableWeights.length > 0) totalWeight += Math.max(...usableWeights);

    if (copies.length !== 1) {
      invalid.push(id);
      continue;
    }
    const obs = copies[0];
    const wellFormed =
      typeof obs.sourceId === "string" &&
      obs.sourceId.length > 0 &&
      typeof obs.value === "number" &&
      Number.isFinite(obs.value) &&
      isUsableWeight(obs.weight) &&
      typeof obs.observedAt === "number" &&
      Number.isFinite(obs.observedAt) &&
      obs.observedAt <= now + policy.maxFutureSkewMs;
    if (!wellFormed) {
      invalid.push(id);
    } else if (now - obs.observedAt > policy.maxStalenessMs) {
      stale.push(id);
    } else {
      fresh.push(obs);
    }
  }

  const base = {
    invalidSources: invalid.sort(),
    staleSources: stale.sort(),
    totalWeight,
    evaluatedAt: now,
  };

  if (fresh.length === 0) {
    return finalize(observations, policy, {
      ...base,
      status: "no_valid_sources",
      value: null,
      trustTier: TrustTier.Unverified,
      center: null,
      agreeingSources: [],
      outlierSources: [],
      agreeingWeight: 0,
      sourceTimestamp: null,
    });
  }

  const center = median(fresh.map((o) => o.value));
  const agreeing = fresh.filter((o) => !isAnomalous(o.value, center, policy));
  const outliers = fresh.filter((o) => isAnomalous(o.value, center, policy));
  const agreeingWeight = agreeing.reduce((sum, o) => sum + o.weight, 0);

  const common = {
    ...base,
    center,
    agreeingSources: agreeing.map((o) => o.sourceId).sort(),
    outlierSources: outliers.map((o) => o.sourceId).sort(),
    agreeingWeight,
  };

  let status: ConsensusStatus = "agreed";
  if (agreeing.length < policy.minAgreeingSources) status = "insufficient_sources";
  else if (!meetsQuorum(agreeingWeight, totalWeight, policy.quorumRatio)) status = "no_quorum";

  if (status !== "agreed") {
    return finalize(observations, policy, {
      ...common,
      status,
      value: null,
      trustTier: TrustTier.Unverified,
      sourceTimestamp: null,
    });
  }

  let trustTier: TrustTier;
  if (agreeing.length === 1) trustTier = TrustTier.SingleSource;
  else if (agreeing.length >= 3 && outliers.length === 0 && stale.length === 0 && invalid.length === 0) {
    trustTier = TrustTier.Unanimous;
  } else trustTier = TrustTier.Corroborated;

  return finalize(observations, policy, {
    ...common,
    status,
    value: median(agreeing.map((o) => o.value)),
    trustTier,
    sourceTimestamp: Math.min(...agreeing.map((o) => o.observedAt)),
  });
}

function finalize(
  observations: readonly SourceObservation[],
  policy: ConsensusPolicy,
  decision: Omit<ConsensusDecision, "decisionId">
): ConsensusDecision {
  return { ...decision, decisionId: computeDecisionId(observations, policy, decision) };
}

/**
 * Deterministic 64-bit decision id: a truncated SHA-256 over the canonical
 * (sorted) inputs and the outcome. Re-running the same round reproduces the
 * same id, which lets an auditor tie an on-chain value back to its inputs.
 */
export function computeDecisionId(
  observations: readonly SourceObservation[],
  policy: ConsensusPolicy,
  decision: Pick<ConsensusDecision, "status" | "value" | "evaluatedAt">
): string {
  // String() keeps NaN / Infinity / -0 distinguishable, unlike JSON numbers.
  const rows = observations
    .map((o) => [String(o?.sourceId), String(o?.value), String(o?.weight), String(o?.observedAt)].join("|"))
    .sort();
  const canonical = JSON.stringify({
    v: 1,
    rows,
    policy: [
      policy.quorumRatio,
      policy.minAgreeingSources,
      policy.maxDeviationRatio,
      policy.absoluteDeviationFloor,
      policy.maxStalenessMs,
      policy.maxFutureSkewMs,
    ].map(String),
    status: decision.status,
    value: String(decision.value),
    at: String(decision.evaluatedAt),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
