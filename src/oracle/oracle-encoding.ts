import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { ConsensusDecision, TrustTier } from "./consensus/consensus";

export { TrustTier } from "./consensus/consensus";

/**
 * Fixed-point encoding of OracleReading.value → i128 for RefractOracle.
 *
 * OracleReading.value is a JS float whose meaning depends on coverage type:
 *   - StablecoinDepeg: USDC price (e.g. 0.9998)
 *   - MarketCrash: 24h % change (e.g. -30.12)
 *   - LiquidationShield: mock ratio / severity signal (0–1 style)
 *   - SmartContractRisk: TVL drop % (e.g. -12.5)
 *   - FlightDelay: delay minutes (e.g. 247)
 *
 * The on-chain oracle stores i128 fixed-point integers. Scaling is
 * deterministic (Math.round) so claim triggers are reproducible:
 *
 * | coverageType       | scale                         | example           |
 * |--------------------|-------------------------------|-------------------|
 * | StablecoinDepeg    | price × 10_000_000 (1e7)      | 0.9998 → 9998000  |
 * | MarketCrash        | percent × 100 (centipercent)  | -30.12 → -3012    |
 * | LiquidationShield  | ratio × 10_000 (bps)          | 0.42 → 4200       |
 * | SmartContractRisk  | percent × 100 (centipercent)  | -50 → -5000       |
 * | FlightDelay        | minutes as integer            | 247 → 247         |
 */
export function scaleOracleValue(coverageType: string, value: number): bigint {
  switch (coverageType) {
    case "StablecoinDepeg":
      return BigInt(Math.round(value * 10_000_000));
    case "MarketCrash":
    case "SmartContractRisk":
      return BigInt(Math.round(value * 100));
    case "LiquidationShield":
      return BigInt(Math.round(value * 10_000));
    case "FlightDelay":
      return BigInt(Math.round(value));
    default:
      throw new Error(`Unknown coverageType for oracle scaling: ${coverageType}`);
  }
}

/** Stable u32 discriminant matching CoverageType declaration order in the pool. */
export function coverageTypeToU32(coverageType: string): number {
  const map: Record<string, number> = {
    StablecoinDepeg: 0,
    MarketCrash: 1,
    LiquidationShield: 2,
    SmartContractRisk: 3,
    FlightDelay: 4,
  };
  const id = map[coverageType];
  if (id === undefined) {
    throw new Error(`Unknown coverageType: ${coverageType}`);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Reading provenance
// ---------------------------------------------------------------------------

/**
 * Where a published value came from, carried on-chain next to the value so
 * consumers and auditors can tell a corroborated reading from a
 * single-source one without leaving the ledger.
 */
export interface ReadingProvenance {
  /** Consensus trust tier. Unverified readings are never encoded. */
  trustTier: TrustTier;
  /** How many independent sources agreed (0–255). */
  agreeingSources: number;
  /**
   * Consensus decision id (u64) as 16 lowercase hex chars; reproducible from
   * the round's inputs. A string, not a bigint, so readings stay JSON-safe.
   */
  decisionId: string;
  /** Earliest agreeing source observation time, Unix seconds (40-bit). */
  sourceTimestamp: number;
}

/** Current provenance layout version. Bump when the layout changes. */
export const PROVENANCE_VERSION = 1;

const TIMESTAMP_MAX = 2 ** 40 - 1; // ~year 36812
const U128_MAX = (1n << 128n) - 1n;

/**
 * Packed provenance layout (u128, most significant bits first):
 *
 * | bits     | width | field                                  |
 * |----------|-------|----------------------------------------|
 * | 127..124 | 4     | layout version (currently 1)           |
 * | 123..120 | 4     | trust tier (TrustTier)                 |
 * | 119..112 | 8     | agreeing source count                  |
 * | 111..104 | 8     | reserved, must be 0                    |
 * | 103..64  | 40    | source timestamp, Unix seconds         |
 * |  63..0   | 64    | consensus decision id                  |
 *
 * Version 0 is never valid, so a zero u128 means "no provenance".
 */
const SHIFT = {
  version: 124n,
  trustTier: 120n,
  agreeingSources: 112n,
  reserved: 104n,
  sourceTimestamp: 64n,
} as const;

export class ProvenanceEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvenanceEncodingError";
  }
}

/** Rejects provenance that is out of range or internally inconsistent. */
export function assertValidProvenance(p: ReadingProvenance): void {
  if (typeof p.trustTier !== "number" || TrustTier[p.trustTier] === undefined) {
    throw new ProvenanceEncodingError(`Unknown trust tier: ${String(p.trustTier)}`);
  }
  if (p.trustTier === TrustTier.Unverified) {
    throw new ProvenanceEncodingError("Unverified readings must not be published on-chain");
  }
  if (!Number.isInteger(p.agreeingSources) || p.agreeingSources < 0 || p.agreeingSources > 255) {
    throw new ProvenanceEncodingError(`agreeingSources must be an integer in 0..255, got ${p.agreeingSources}`);
  }
  const minSources: Record<number, number> = {
    [TrustTier.SingleSource]: 1,
    [TrustTier.Corroborated]: 2,
    [TrustTier.Unanimous]: 3,
  };
  if (p.trustTier === TrustTier.SingleSource ? p.agreeingSources !== 1 : p.agreeingSources < minSources[p.trustTier]) {
    throw new ProvenanceEncodingError(
      `Trust tier ${TrustTier[p.trustTier]} is inconsistent with ${p.agreeingSources} agreeing source(s)`
    );
  }
  if (typeof p.decisionId !== "string" || !/^[0-9a-f]{16}$/.test(p.decisionId)) {
    throw new ProvenanceEncodingError("decisionId must be 16 lowercase hex chars (u64)");
  }
  if (!Number.isInteger(p.sourceTimestamp) || p.sourceTimestamp < 0 || p.sourceTimestamp > TIMESTAMP_MAX) {
    throw new ProvenanceEncodingError(`sourceTimestamp must be Unix seconds in 0..2^40-1, got ${p.sourceTimestamp}`);
  }
}

/** Pack provenance into the u128 layout above. */
export function packProvenance(p: ReadingProvenance): bigint {
  assertValidProvenance(p);
  return (
    (BigInt(PROVENANCE_VERSION) << SHIFT.version) |
    (BigInt(p.trustTier) << SHIFT.trustTier) |
    (BigInt(p.agreeingSources) << SHIFT.agreeingSources) |
    (BigInt(p.sourceTimestamp) << SHIFT.sourceTimestamp) |
    BigInt(`0x${p.decisionId}`)
  );
}

/** Inverse of packProvenance. Rejects unknown versions and non-zero reserved bits. */
export function unpackProvenance(packed: bigint): ReadingProvenance {
  if (typeof packed !== "bigint" || packed < 0n || packed > U128_MAX) {
    throw new ProvenanceEncodingError("Packed provenance must be a u128 bigint");
  }
  const field = (shift: bigint, bits: bigint) => (packed >> shift) & ((1n << bits) - 1n);
  const version = Number(field(SHIFT.version, 4n));
  if (version !== PROVENANCE_VERSION) {
    throw new ProvenanceEncodingError(`Unsupported provenance version ${version}`);
  }
  if (field(SHIFT.reserved, 8n) !== 0n) {
    throw new ProvenanceEncodingError("Reserved provenance bits are set");
  }
  const provenance: ReadingProvenance = {
    trustTier: Number(field(SHIFT.trustTier, 4n)) as TrustTier,
    agreeingSources: Number(field(SHIFT.agreeingSources, 8n)),
    sourceTimestamp: Number(field(SHIFT.sourceTimestamp, 40n)),
    decisionId: field(0n, 64n).toString(16).padStart(16, "0"),
  };
  assertValidProvenance(provenance);
  return provenance;
}

/**
 * Derive on-chain provenance from a consensus decision. Throws for anything
 * other than an agreed decision — those must never be published.
 */
export function provenanceFromDecision(decision: ConsensusDecision): ReadingProvenance {
  if (decision.status !== "agreed" || decision.sourceTimestamp === null) {
    throw new ProvenanceEncodingError(`Cannot publish a ${decision.status} consensus decision`);
  }
  const provenance: ReadingProvenance = {
    trustTier: decision.trustTier,
    agreeingSources: decision.agreeingSources.length,
    decisionId: decision.decisionId,
    // Floor so the on-chain timestamp never claims fresher data than we had.
    sourceTimestamp: Math.floor(decision.sourceTimestamp / 1000),
  };
  assertValidProvenance(provenance);
  return provenance;
}

/** Everything `update_reading` needs, already scaled and packed. */
export interface EncodedOracleReading {
  coverageType: number;
  value: bigint;
  provenance: bigint;
}

/** Scale the value and pack provenance for one reading. */
export function encodeReadingForChain(
  coverageType: string,
  value: number,
  provenance: ReadingProvenance
): EncodedOracleReading {
  return {
    coverageType: coverageTypeToU32(coverageType),
    value: scaleOracleValue(coverageType, value),
    provenance: packProvenance(provenance),
  };
}

/**
 * ScVal arguments for
 * `RefractOracle.update_reading(coverage_type: u32, value: i128, provenance: u128)`.
 *
 * The provenance argument requires the matching contract change; until that
 * ships, publishers keep calling the two-argument form.
 */
export function buildUpdateReadingArgs(encoded: EncodedOracleReading): xdr.ScVal[] {
  return [
    nativeToScVal(encoded.coverageType, { type: "u32" }),
    nativeToScVal(encoded.value, { type: "i128" }),
    nativeToScVal(encoded.provenance, { type: "u128" }),
  ];
}
