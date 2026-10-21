import {
  ConsensusPolicy,
  DEFAULT_CONSENSUS_POLICY,
  SourceObservation,
  TrustTier,
  deviationTolerance,
  evaluateConsensus,
  isAnomalous,
  median,
  meetsQuorum,
  validateConsensusPolicy,
} from "./consensus";

const NOW = 1_800_000_000_000;

function obs(sourceId: string, value: number, overrides: Partial<SourceObservation> = {}): SourceObservation {
  return { sourceId, value, weight: 1, observedAt: NOW - 1_000, ...overrides };
}

const policy: ConsensusPolicy = { ...DEFAULT_CONSENSUS_POLICY };

describe("median", () => {
  it("returns the middle element for odd lengths", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it("averages the middle pair for even lengths", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("does not overflow on large values", () => {
    expect(median([Number.MAX_VALUE, Number.MAX_VALUE])).toBe(Number.MAX_VALUE);
  });

  it("stays inside the input range for subnormal values (found by property test)", () => {
    expect(median([5e-324, 5e-324, 5e-324, 5e-324])).toBe(5e-324);
  });

  it("rejects empty and non-finite input", () => {
    expect(() => median([])).toThrow(RangeError);
    expect(() => median([1, NaN])).toThrow(RangeError);
    expect(() => median([Infinity])).toThrow(RangeError);
  });
});

describe("meetsQuorum", () => {
  it("is inclusive at the boundary", () => {
    expect(meetsQuorum(2, 3, 2 / 3)).toBe(true);
    expect(meetsQuorum(1.99, 3, 2 / 3)).toBe(false);
  });

  it("never passes with zero or invalid total weight", () => {
    expect(meetsQuorum(0, 0, 0.5)).toBe(false);
    expect(meetsQuorum(1, NaN, 0.5)).toBe(false);
    expect(meetsQuorum(1, Infinity, 0.5)).toBe(false);
  });
});

describe("anomaly threshold", () => {
  it("accepts values exactly at the tolerance and rejects values past it", () => {
    const p = { ...policy, maxDeviationRatio: 0.5, absoluteDeviationFloor: 0 };
    expect(deviationTolerance(10, p)).toBe(5);
    expect(isAnomalous(15, 10, p)).toBe(false);
    expect(isAnomalous(15.000001, 10, p)).toBe(true);
  });

  it("falls back to the absolute floor around zero", () => {
    const p = { ...policy, maxDeviationRatio: 0.02, absoluteDeviationFloor: 0.5 };
    expect(isAnomalous(0.4, 0, p)).toBe(false);
    expect(isAnomalous(0.6, 0, p)).toBe(true);
  });
});

describe("validateConsensusPolicy", () => {
  it.each<[string, Partial<ConsensusPolicy>]>([
    ["zero quorum", { quorumRatio: 0 }],
    ["quorum above one", { quorumRatio: 1.01 }],
    ["fractional min sources", { minAgreeingSources: 1.5 }],
    ["negative deviation", { maxDeviationRatio: -1 }],
    ["NaN staleness", { maxStalenessMs: NaN }],
  ])("rejects %s", (_label, override) => {
    expect(() => validateConsensusPolicy({ ...policy, ...override })).toThrow(RangeError);
  });
});

describe("evaluateConsensus", () => {
  it("agrees on the median of agreeing sources and drops the outlier", () => {
    const d = evaluateConsensus(
      [obs("a", 0.9990), obs("b", 1.0000), obs("c", 1.0010), obs("evil", 0.5)],
      { ...policy, quorumRatio: 0.5 },
      NOW
    );
    expect(d.status).toBe("agreed");
    expect(d.value).toBeCloseTo(1.0, 10);
    expect(d.agreeingSources).toEqual(["a", "b", "c"]);
    expect(d.outlierSources).toEqual(["evil"]);
    expect(d.trustTier).toBe(TrustTier.Corroborated);
    expect(d.decisionId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("reports Unanimous only when every source is fresh, valid and agreeing", () => {
    const d = evaluateConsensus([obs("a", 1), obs("b", 1), obs("c", 1)], policy, NOW);
    expect(d.trustTier).toBe(TrustTier.Unanimous);
  });

  it("reports SingleSource when policy allows one source", () => {
    const d = evaluateConsensus([obs("a", 1)], { ...policy, minAgreeingSources: 1 }, NOW);
    expect(d.status).toBe("agreed");
    expect(d.trustTier).toBe(TrustTier.SingleSource);
  });

  it("refuses a single source under the default policy", () => {
    const d = evaluateConsensus([obs("a", 1)], policy, NOW);
    expect(d.status).toBe("insufficient_sources");
    expect(d.value).toBeNull();
    expect(d.trustTier).toBe(TrustTier.Unverified);
  });

  it("fails quorum when agreeing weight is too small, even with more agreeing sources", () => {
    const d = evaluateConsensus(
      [obs("a", 1, { weight: 1 }), obs("b", 1, { weight: 1 }), obs("whale", 2, { weight: 10 })],
      { ...policy, quorumRatio: 0.5 },
      NOW
    );
    // Median of [1, 1, 2] is 1, so the whale is the outlier — but it still
    // holds most of the weight, so the honest pair cannot reach quorum.
    expect(d.outlierSources).toEqual(["whale"]);
    expect(d.status).toBe("no_quorum");
  });

  it("marks stale and future-dated observations", () => {
    const d = evaluateConsensus(
      [
        obs("a", 1),
        obs("b", 1),
        obs("old", 1, { observedAt: NOW - policy.maxStalenessMs - 1 }),
        obs("future", 1, { observedAt: NOW + policy.maxFutureSkewMs + 1 }),
      ],
      { ...policy, quorumRatio: 0.5 },
      NOW
    );
    expect(d.staleSources).toEqual(["old"]);
    expect(d.invalidSources).toEqual(["future"]);
    expect(d.status).toBe("agreed");
    expect(d.trustTier).toBe(TrustTier.Corroborated);
  });

  it("invalidates every copy of a duplicated source id", () => {
    const d = evaluateConsensus([obs("a", 1), obs("a", 1), obs("b", 1)], policy, NOW);
    expect(d.invalidSources).toEqual(["a"]);
    expect(d.agreeingSources).toEqual(["b"]);
    expect(d.status).toBe("insufficient_sources");
  });

  it("counts invalid sources in the quorum denominator", () => {
    const d = evaluateConsensus(
      [obs("a", 1), obs("b", 1), obs("bad1", NaN), obs("bad2", NaN)],
      { ...policy, quorumRatio: 0.75 },
      NOW
    );
    expect(d.totalWeight).toBe(4);
    expect(d.status).toBe("no_quorum");
  });

  it("uses the earliest agreeing timestamp as the source timestamp", () => {
    const d = evaluateConsensus([obs("a", 1, { observedAt: NOW - 5_000 }), obs("b", 1)], policy, NOW);
    expect(d.sourceTimestamp).toBe(NOW - 5_000);
  });

  it("produces the same decision id for the same inputs in any order", () => {
    const xs = [obs("a", 1), obs("b", 1.001), obs("c", 0.999)];
    const d1 = evaluateConsensus(xs, policy, NOW);
    const d2 = evaluateConsensus([...xs].reverse(), policy, NOW);
    expect(d2.decisionId).toBe(d1.decisionId);
    const d3 = evaluateConsensus(xs, policy, NOW + 1);
    expect(d3.decisionId).not.toBe(d1.decisionId);
  });
});
