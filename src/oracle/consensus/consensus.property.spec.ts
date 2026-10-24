import fc from "fast-check";
import {
  ConsensusDecision,
  ConsensusPolicy,
  SourceObservation,
  TrustTier,
  deviationTolerance,
  evaluateConsensus,
  isAnomalous,
  median,
  meetsQuorum,
} from "./consensus";

/**
 * Property-based and fuzz tests for the consensus math.
 *
 * Each property states an invariant that must hold for every input, and
 * fast-check searches for a counterexample (including adversarial ones:
 * NaN, Infinity, huge magnitudes, duplicated ids, colluding outliers).
 * On failure fast-check prints the seed and a shrunk counterexample; rerun
 * with FC_SEED=<seed> to reproduce.
 *
 * FC_NUM_RUNS raises the run count for deeper soak runs, e.g.
 *   FC_NUM_RUNS=20000 npm run test:property
 */
const numRuns = Number(process.env.FC_NUM_RUNS ?? 300);
const seed = process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined;
fc.configureGlobal({ numRuns, ...(seed !== undefined ? { seed } : {}) });

const NOW = 1_800_000_000_000;

// ---------------------------------------------------------------- arbitraries

/** Finite doubles across a wide but non-overflowing range. */
const finite = fc.double({ min: -1e12, max: 1e12, noNaN: true, noDefaultInfinity: true });

/** Integers small enough that sums and products stay exact in a double. */
const exactInt = fc.integer({ min: -1_000_000, max: 1_000_000 });

/** Any number at all, including the values that break naive math. */
const hostileNumber = fc.oneof(
  finite,
  fc.constantFrom(NaN, Infinity, -Infinity, -0, Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE),
  fc.double()
);

const validPolicy: fc.Arbitrary<ConsensusPolicy> = fc.record({
  quorumRatio: fc.double({ min: 0.01, max: 1, noNaN: true }),
  minAgreeingSources: fc.integer({ min: 1, max: 5 }),
  maxDeviationRatio: fc.double({ min: 0, max: 0.5, noNaN: true }),
  absoluteDeviationFloor: fc.double({ min: 0, max: 10, noNaN: true }),
  maxStalenessMs: fc.integer({ min: 0, max: 600_000 }),
  maxFutureSkewMs: fc.integer({ min: 0, max: 60_000 }),
});

/** Well-formed observation with a unique-ish id drawn from a small pool. */
function wellFormedObs(ids: fc.Arbitrary<string>): fc.Arbitrary<SourceObservation> {
  return fc.record({
    sourceId: ids,
    value: finite,
    weight: fc.integer({ min: 0, max: 1_000 }),
    observedAt: fc.integer({ min: NOW - 900_000, max: NOW + 90_000 }),
  });
}

/** Observation where every field may be garbage. */
const hostileObs: fc.Arbitrary<SourceObservation> = fc.record({
  sourceId: fc.oneof(fc.constantFrom("a", "b", "c", "d", ""), fc.string({ maxLength: 4 })),
  value: hostileNumber,
  weight: hostileNumber,
  observedAt: fc.oneof(fc.integer({ min: NOW - 900_000, max: NOW + 90_000 }), hostileNumber),
});

/** Uniquely-identified, fresh, well-formed observations. */
function freshUniqueObs(
  values: fc.Arbitrary<number>,
  weights: fc.Arbitrary<number> = fc.integer({ min: 1, max: 100 }),
  { minLength = 1, maxLength = 12 } = {}
): fc.Arbitrary<SourceObservation[]> {
  return fc
    .array(fc.record({ value: values, weight: weights, age: fc.integer({ min: 0, max: 1_000 }) }), {
      minLength,
      maxLength,
    })
    .map((rows) => rows.map((r, i) => ({ sourceId: `s${i}`, value: r.value, weight: r.weight, observedAt: NOW - r.age })));
}

/** A permutation of `xs`, chosen by fast-check so it shrinks well. */
function permuted<T>(xs: T[]): fc.Arbitrary<T[]> {
  return fc
    .array(fc.nat(), { minLength: xs.length, maxLength: xs.length })
    .map((keys) => xs.map((x, i) => ({ x, k: keys[i], i })).sort((p, q) => p.k - q.k || p.i - q.i).map((p) => p.x));
}

function sortedLists(d: ConsensusDecision) {
  return [d.agreeingSources, d.outlierSources, d.staleSources, d.invalidSources];
}

// ---------------------------------------------------------------- median

describe("median — properties", () => {
  it("lies between the minimum and maximum", () => {
    fc.assert(
      fc.property(fc.array(finite, { minLength: 1 }), (xs) => {
        const m = median(xs);
        return m >= Math.min(...xs) && m <= Math.max(...xs);
      })
    );
  });

  it("does not depend on input order", () => {
    fc.assert(
      fc.property(
        fc.array(finite, { minLength: 1 }).chain((xs) => fc.tuple(fc.constant(xs), permuted(xs))),
        ([xs, ys]) => Object.is(median(xs), median(ys))
      )
    );
  });

  it("is an element of the input for odd lengths", () => {
    fc.assert(
      fc.property(
        fc.array(finite, { minLength: 1 }).filter((xs) => xs.length % 2 === 1),
        (xs) => xs.includes(median(xs))
      )
    );
  });

  it("splits the input: at most half the values lie strictly on either side", () => {
    fc.assert(
      fc.property(fc.array(finite, { minLength: 1 }), (xs) => {
        const m = median(xs);
        const below = xs.filter((x) => x < m).length;
        const above = xs.filter((x) => x > m).length;
        return below <= xs.length / 2 && above <= xs.length / 2;
      })
    );
  });

  it("never decreases when one input increases", () => {
    fc.assert(
      fc.property(
        fc.array(exactInt, { minLength: 1 }),
        fc.nat(),
        fc.integer({ min: 0, max: 1_000_000 }),
        (xs, idx, bump) => {
          const ys = [...xs];
          ys[idx % ys.length] += bump;
          return median(ys) >= median(xs);
        }
      )
    );
  });

  it("shifts exactly with a constant offset (exact integer arithmetic)", () => {
    fc.assert(
      fc.property(fc.array(exactInt, { minLength: 1 }), exactInt, (xs, c) => {
        return median(xs.map((x) => x + c)) === median(xs) + c;
      })
    );
  });

  it("stays inside the honest range while honest values outnumber adversarial ones", () => {
    fc.assert(
      fc.property(
        fc.array(finite, { minLength: 1, maxLength: 20 }),
        fc.array(fc.oneof(finite, fc.constantFrom(Number.MAX_VALUE, -Number.MAX_VALUE)), { maxLength: 19 }),
        (honest, adversarial) => {
          fc.pre(adversarial.length < honest.length);
          const m = median([...honest, ...adversarial]);
          return m >= Math.min(...honest) && m <= Math.max(...honest);
        }
      )
    );
  });

  it("rejects any non-finite input instead of returning garbage", () => {
    fc.assert(
      fc.property(
        fc.array(finite),
        fc.constantFrom(NaN, Infinity, -Infinity),
        fc.nat(),
        (xs, bad, at) => {
          const ys = [...xs];
          ys.splice(at % (ys.length + 1), 0, bad);
          expect(() => median(ys)).toThrow(RangeError);
        }
      )
    );
  });
});

// ---------------------------------------------------------------- weighted quorum

describe("weighted quorum — properties", () => {
  const weightPair = fc
    .tuple(fc.integer({ min: 0, max: 1_000_000 }), fc.integer({ min: 1, max: 1_000_000 }))
    .map(([a, extra]) => ({ agreeing: a, total: a + extra - 1 }))
    .filter(({ total }) => total > 0);
  const ratio = fc.double({ min: 0.001, max: 1, noNaN: true });

  it("does not change when every weight is scaled by the same factor", () => {
    fc.assert(
      fc.property(weightPair, ratio, fc.integer({ min: 1, max: 1_000_000 }), ({ agreeing, total }, r, k) => {
        return meetsQuorum(agreeing, total, r) === meetsQuorum(agreeing * k, total * k, r);
      })
    );
  });

  it("is monotone: more agreeing weight never loses quorum", () => {
    fc.assert(
      fc.property(weightPair, ratio, fc.nat(), ({ agreeing, total }, r, extra) => {
        const more = Math.min(agreeing + extra, total);
        return !meetsQuorum(agreeing, total, r) || meetsQuorum(more, total, r);
      })
    );
  });

  it("is monotone: a lower bar never loses quorum", () => {
    fc.assert(
      fc.property(weightPair, ratio, ratio, ({ agreeing, total }, r1, r2) => {
        const [lo, hi] = r1 <= r2 ? [r1, r2] : [r2, r1];
        return !meetsQuorum(agreeing, total, hi) || meetsQuorum(agreeing, total, lo);
      })
    );
  });

  it("always passes on full agreement and never on zero agreement", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), ratio, (total, r) => {
        return meetsQuorum(total, total, r) && !meetsQuorum(0, total, r);
      })
    );
  });

  it("never passes when total weight is zero, negative or non-finite", () => {
    fc.assert(
      fc.property(hostileNumber, fc.oneof(fc.constantFrom(0, -0, NaN, Infinity, -Infinity), fc.double({ max: 0 })), ratio, (a, t, r) => {
        return !meetsQuorum(a, t, r);
      })
    );
  });
});

// ---------------------------------------------------------------- anomaly threshold

describe("anomaly threshold — properties", () => {
  it("never flags the center itself", () => {
    fc.assert(fc.property(finite, validPolicy, (c, p) => !isAnomalous(c, c, p)));
  });

  it("is symmetric around the center", () => {
    fc.assert(
      fc.property(exactInt, fc.integer({ min: 0, max: 1_000_000 }), validPolicy, (c, d, p) => {
        return isAnomalous(c + d, c, p) === isAnomalous(c - d, c, p);
      })
    );
  });

  it("is monotone in distance: further from the center never becomes less anomalous", () => {
    fc.assert(
      fc.property(finite, fc.double({ min: 0, max: 1e6, noNaN: true }), fc.double({ min: 0, max: 1e6, noNaN: true }), validPolicy, (c, d1, d2, p) => {
        const [near, far] = d1 <= d2 ? [d1, d2] : [d2, d1];
        return !isAnomalous(c + near, c, p) || isAnomalous(c + far, c, p) || c + near === c + far;
      })
    );
  });

  it("widening the tolerance never turns an agreeing value into an outlier", () => {
    fc.assert(
      fc.property(finite, finite, validPolicy, fc.double({ min: 0, max: 1, noNaN: true }), (v, c, p, widen) => {
        const wider = { ...p, maxDeviationRatio: p.maxDeviationRatio + widen, absoluteDeviationFloor: p.absoluteDeviationFloor + widen };
        return isAnomalous(v, c, p) || !isAnomalous(v, c, wider);
      })
    );
  });
});

// ---------------------------------------------------------------- evaluateConsensus

describe("evaluateConsensus — fuzz", () => {
  it("never throws on hostile observations and always returns a coherent decision", () => {
    fc.assert(
      fc.property(fc.array(hostileObs, { maxLength: 15 }), validPolicy, (xs, p) => {
        const d = evaluateConsensus(xs, p, NOW);

        // Shape
        expect(d.decisionId).toMatch(/^[0-9a-f]{16}$/);
        expect(Number.isFinite(d.totalWeight) || d.totalWeight === Infinity).toBe(true);

        // Every distinct id lands in exactly one bucket.
        const buckets = sortedLists(d).flat();
        expect(new Set(buckets).size).toBe(buckets.length);
        expect(new Set(buckets)).toEqual(new Set(xs.map((o) => String(o.sourceId))));

        // Agreed ⇔ a finite value is published.
        if (d.status === "agreed") {
          expect(Number.isFinite(d.value)).toBe(true);
          expect(d.trustTier).not.toBe(TrustTier.Unverified);
          expect(Number.isFinite(d.sourceTimestamp)).toBe(true);
        } else {
          expect(d.value).toBeNull();
          expect(d.trustTier).toBe(TrustTier.Unverified);
          expect(d.sourceTimestamp).toBeNull();
        }
      })
    );
  });

  it("only agrees when the source count and weighted quorum are both met", () => {
    fc.assert(
      fc.property(fc.array(hostileObs, { maxLength: 15 }), validPolicy, (xs, p) => {
        const d = evaluateConsensus(xs, p, NOW);
        if (d.status !== "agreed") return true;
        return d.agreeingSources.length >= p.minAgreeingSources && d.agreeingWeight / d.totalWeight >= p.quorumRatio;
      })
    );
  });

  it("never lets a source vote twice", () => {
    fc.assert(
      fc.property(fc.array(wellFormedObs(fc.constantFrom("a", "b", "c")), { maxLength: 10 }), validPolicy, (xs, p) => {
        const d = evaluateConsensus(xs, p, NOW);
        const counts = new Map<string, number>();
        for (const o of xs) counts.set(o.sourceId, (counts.get(o.sourceId) ?? 0) + 1);
        for (const [id, n] of counts) {
          if (n > 1 && !d.invalidSources.includes(id)) return false;
        }
        return true;
      })
    );
  });
});

describe("evaluateConsensus — properties", () => {
  it("does not depend on observation order", () => {
    fc.assert(
      fc.property(
        fc.array(hostileObs, { maxLength: 12 }).chain((xs) => fc.tuple(fc.constant(xs), permuted(xs))),
        validPolicy,
        ([xs, ys], p) => {
          const a = evaluateConsensus(xs, p, NOW);
          const b = evaluateConsensus(ys, p, NOW);
          expect(b).toEqual(a);
        }
      )
    );
  });

  it("is deterministic", () => {
    fc.assert(
      fc.property(fc.array(hostileObs, { maxLength: 12 }), validPolicy, (xs, p) => {
        expect(evaluateConsensus(xs, p, NOW)).toEqual(evaluateConsensus(xs, p, NOW));
      })
    );
  });

  it("classifies agreeing and outlier sources by the tolerance around the center", () => {
    fc.assert(
      fc.property(freshUniqueObs(finite), validPolicy, (xs, p) => {
        const d = evaluateConsensus(xs, { ...p, maxStalenessMs: 10_000 }, NOW);
        const byId = new Map(xs.map((o) => [o.sourceId, o.value]));
        const tol = deviationTolerance(d.center!, p);
        for (const id of d.agreeingSources) expect(Math.abs(byId.get(id)! - d.center!)).toBeLessThanOrEqual(tol);
        for (const id of d.outlierSources) expect(Math.abs(byId.get(id)! - d.center!)).toBeGreaterThan(tol);
      })
    );
  });

  it("publishes a value inside the range of the agreeing sources", () => {
    fc.assert(
      fc.property(freshUniqueObs(finite), validPolicy, (xs, p) => {
        const d = evaluateConsensus(xs, { ...p, maxStalenessMs: 10_000 }, NOW);
        if (d.status !== "agreed") return true;
        const vals = xs.filter((o) => d.agreeingSources.includes(o.sourceId)).map((o) => o.value);
        return d.value! >= Math.min(...vals) && d.value! <= Math.max(...vals);
      })
    );
  });

  it("never treats a stale observation as agreeing", () => {
    fc.assert(
      fc.property(fc.array(wellFormedObs(fc.string({ minLength: 1, maxLength: 3 })), { maxLength: 12 }), validPolicy, (xs, p) => {
        const d = evaluateConsensus(xs, p, NOW);
        return xs.every((o) => !(NOW - o.observedAt > p.maxStalenessMs) || !d.agreeingSources.includes(o.sourceId));
      })
    );
  });

  it("bounds adversarial influence: a minority cannot move the value outside honest range ± tolerance", () => {
    fc.assert(
      fc.property(
        freshUniqueObs(finite, fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 10 }),
        fc.array(hostileNumber, { maxLength: 9 }),
        validPolicy,
        (honest, adversarialValues, p) => {
          fc.pre(adversarialValues.length < honest.length);
          const adversaries = adversarialValues.map((value, i) => ({
            sourceId: `adv${i}`,
            value,
            weight: 100,
            observedAt: NOW,
          }));
          const d = evaluateConsensus([...honest, ...adversaries], { ...p, maxStalenessMs: 10_000 }, NOW);
          if (d.status !== "agreed") return true;
          const hv = honest.map((o) => o.value);
          const lo = Math.min(...hv);
          const hi = Math.max(...hv);
          // Center sits inside the honest range; every agreeing value is
          // within tolerance of the center, so is the median of them.
          const tol = deviationTolerance(d.center!, p);
          return d.center! >= lo && d.center! <= hi && d.value! >= lo - tol && d.value! <= hi + tol;
        }
      )
    );
  });

  it("an honest, tightly clustered majority with quorum weight always agrees and rejects distant adversaries", () => {
    fc.assert(
      fc.property(
        exactInt,
        fc.integer({ min: 2, max: 10 }),
        fc.integer({ min: 0, max: 9 }),
        fc.double({ min: 1, max: 100, noNaN: true }),
        fc.array(fc.double({ min: -0.25, max: 0.25, noNaN: true }), { minLength: 10, maxLength: 10 }),
        fc.array(fc.oneof(fc.double({ min: 3, max: 1e9, noNaN: true }), fc.double({ min: -1e9, max: -3, noNaN: true })), {
          minLength: 9,
          maxLength: 9,
        }),
        (center, honestCount, advCount, floor, jitter, advOffsets) => {
          fc.pre(advCount < honestCount);
          // Purely absolute tolerance; honest spread is ±floor/4, adversaries
          // sit at least 3·floor away from the cluster.
          const p: ConsensusPolicy = {
            quorumRatio: honestCount / (honestCount + advCount),
            minAgreeingSources: 2,
            maxDeviationRatio: 0,
            absoluteDeviationFloor: floor,
            maxStalenessMs: 60_000,
            maxFutureSkewMs: 0,
          };
          const honest = Array.from({ length: honestCount }, (_, i) => ({
            sourceId: `h${i}`,
            value: center + jitter[i] * floor,
            weight: 1,
            observedAt: NOW,
          }));
          const adv = Array.from({ length: advCount }, (_, i) => ({
            sourceId: `x${i}`,
            value: center + advOffsets[i] * floor,
            weight: 1,
            observedAt: NOW,
          }));
          const d = evaluateConsensus([...honest, ...adv], p, NOW);
          expect(d.status).toBe("agreed");
          expect(d.agreeingSources).toEqual(honest.map((o) => o.sourceId).sort());
          expect(d.outlierSources).toEqual(adv.map((o) => o.sourceId).sort());
          const hv = honest.map((o) => o.value);
          expect(d.value!).toBeGreaterThanOrEqual(Math.min(...hv));
          expect(d.value!).toBeLessThanOrEqual(Math.max(...hv));
        }
      )
    );
  });

  it("assigns trust tiers consistently with the agreeing set", () => {
    fc.assert(
      fc.property(fc.array(hostileObs, { maxLength: 12 }), validPolicy, (xs, p) => {
        const d = evaluateConsensus(xs, p, NOW);
        const n = d.agreeingSources.length;
        switch (d.trustTier) {
          case TrustTier.Unverified:
            return d.status !== "agreed";
          case TrustTier.SingleSource:
            return d.status === "agreed" && n === 1;
          case TrustTier.Corroborated:
            return d.status === "agreed" && n >= 2;
          case TrustTier.Unanimous:
            return (
              d.status === "agreed" &&
              n >= 3 &&
              d.outlierSources.length + d.staleSources.length + d.invalidSources.length === 0
            );
        }
      })
    );
  });
});
