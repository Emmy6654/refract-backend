export interface OracleFeedConfiguration {
  latencyBudgetMs: number;
  requiredQuorum: number;
  unit: string;
  sourceType: "http" | "mock";
}

export const ORACLE_FEEDS = {
  "coingecko-usdc": {
    latencyBudgetMs: 30_000,
    requiredQuorum: 1,
    unit: "USD",
    sourceType: "http",
  },
  "coingecko-stellar": {
    latencyBudgetMs: 30_000,
    requiredQuorum: 1,
    unit: "percent_change_24h",
    sourceType: "http",
  },
  "defillama-aave": {
    latencyBudgetMs: 45_000,
    requiredQuorum: 1,
    unit: "percent_change_24h",
    sourceType: "http",
  },
  "nexus-liquidations": {
    latencyBudgetMs: 10_000,
    requiredQuorum: 1,
    unit: "collateral_ratio",
    sourceType: "mock",
  },
  aviationstack: {
    latencyBudgetMs: 10_000,
    requiredQuorum: 1,
    unit: "minutes",
    sourceType: "mock",
  },
} as const satisfies Record<string, OracleFeedConfiguration>;

export type OracleFeedId = keyof typeof ORACLE_FEEDS;

export interface FeedPayloadRule {
  requiredFields: readonly string[];
  numericRanges: Readonly<Record<string, readonly [number, number]>>;
  maxStepChanges?: Readonly<Record<string, number>>;
  allowedCategoricalValues?: Readonly<Record<string, readonly string[]>>;
  expectedUnits: Readonly<Record<string, string>>;
}

export const ORACLE_FEED_RULES: Readonly<Record<string, FeedPayloadRule>> = {
  "coingecko-usdc": {
    requiredFields: ["price", "unit"],
    numericRanges: { price: [0, 2] },
    maxStepChanges: { price: 0.2 },
    expectedUnits: { unit: "USD" },
  },
  "coingecko-stellar": {
    requiredFields: ["price", "change24h", "unit", "changeUnit"],
    numericRanges: { price: [0, 1_000_000], change24h: [-100, 1_000] },
    maxStepChanges: { price: 25, change24h: 50 },
    expectedUnits: { unit: "USD", changeUnit: "percent" },
  },
  "defillama-aave": {
    requiredFields: ["unit", "tvl[].date", "tvl[].totalLiquidityUSD"],
    numericRanges: {
      "tvl[].date": [0, 4_102_444_800],
      "tvl[].totalLiquidityUSD": [0, 1_000_000_000_000_000],
    },
    maxStepChanges: { "tvl[].totalLiquidityUSD": 20_000_000_000 },
    expectedUnits: { unit: "USD" },
  },
  "nexus-liquidations": {
    requiredFields: ["collateralRatio", "status", "unit"],
    numericRanges: { collateralRatio: [0, 2] },
    allowedCategoricalValues: { status: ["healthy", "liquidated"] },
    expectedUnits: { unit: "ratio" },
  },
  aviationstack: {
    requiredFields: ["flightNumber", "delayMinutes", "status", "unit"],
    numericRanges: { delayMinutes: [0, 10_080] },
    allowedCategoricalValues: { status: ["scheduled", "delayed", "cancelled"] },
    expectedUnits: { unit: "minutes" },
  },
};

export const COVERAGE_REQUIRED_FEEDS = {
  StablecoinDepeg: ["coingecko-usdc"],
  MarketCrash: ["coingecko-stellar"],
  LiquidationShield: ["nexus-liquidations"],
  SmartContractRisk: ["defillama-aave"],
  FlightDelay: ["aviationstack"],
} as const;

export function feedLatencyBudgetMs(
  feedId: string,
  configuredBudgets?: Readonly<Record<string, number>>,
): number {
  const configured = ORACLE_FEEDS[feedId as OracleFeedId];
  const configuredOverride = configuredBudgets?.[feedId];
  if (configuredOverride !== undefined) {
    if (!Number.isInteger(configuredOverride) || configuredOverride <= 0) {
      throw new Error(`Latency budget for ${feedId} must be a positive integer`);
    }
    return configuredOverride;
  }
  const override = process.env.ORACLE_FEED_LATENCY_BUDGETS_MS;
  if (override) {
    let budgets: Record<string, number>;
    try {
      budgets = JSON.parse(override) as Record<string, number>;
    } catch {
      throw new Error("ORACLE_FEED_LATENCY_BUDGETS_MS must be a JSON object of feed IDs to positive integer milliseconds");
    }
    const value = budgets[feedId];
    if (value !== undefined) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`Latency budget for ${feedId} must be a positive integer`);
      }
      return value;
    }
  }
  return configured?.latencyBudgetMs ?? 30_000;
}
