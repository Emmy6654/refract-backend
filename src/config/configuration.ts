/**
 * Typed application configuration, loaded once by Nest's ConfigModule.
 *
 * Kept as a single factory function (rather than scattered `process.env`
 * reads) so every consumer gets the same parsed/defaulted values and the
 * shape is documented in one place. See `.env.example` for the full list
 * of variables this reads.
 */

/** Fee-estimation profiles exposed by FeeStrategyService. */
export type FeeProfileName = "moderate" | "aggressive";

export interface AppConfig {
  port: number;
  frontendUrl: string;
  database: {
    url: string;
  };
  redis: {
    url: string;
  };
  stellar: {
    network: string;
    sorobanRpcUrl: string;
    networkPassphrase: string;
    poolContractId: string;
    policyContractId: string;
    oracleContractId: string;
    relayerSecret: string;
  };
  /**
   * Shared Soroban confirmation poller defaults (see
   * `pollForConfirmation`). Per-call overrides let the HTTP submit path
   * use a short deadline while settlement/oracle publish use a longer one.
   */
  confirmation: {
    initialIntervalMs: number;
    backoffMultiplier: number;
    maxIntervalMs: number;
    deadlineMs: number;
    jitterRatio: number;
    /** Longer deadline for relayer-signed settlement / oracle publishes. */
    settlementDeadlineMs: number;
    /** Shorter deadline so HTTP handlers don't block for a full minute. */
    httpDeadlineMs: number;
  };
  oraclePublish: {
    /**
     * `every_poll` — publish on every scheduler tick (subject to min interval).
     * `on_change` — publish only when the scaled fixed-point value changes
     * (default; bounds fee spend).
     */
    mode: "every_poll" | "on_change";
    /** Floor between publishes for the same coverage type (ms). */
    minIntervalMs: number;
  };
  oracles: {
    coingeckoBaseUrl: string;
    horizonUrl: string;
    defiLlamaBaseUrl: string;
    defiLlamaProtocolSlug: string;
    httpTimeoutMs: number;
  };
  /** Soroban inclusion-fee estimation strategy. */
  fees: {
    /** Hard ceiling (stroops) above which FeeCeilingExceededError is thrown. */
    ceilingStroops: string;
    /** TTL for the cached getFeeStats response (ms). */
    statsTtlMs: number;
    /** Per-profile percentile + multiplier used to derive an inclusion fee. */
    profiles: Record<FeeProfileName, { percentile: number; multiplier: number }>;
  };
  /** Background Soroban event indexer settings. */
  eventIndexer: {
    enabled: boolean;
    pollIntervalMs: number;
    lagAlertLedgers: number;
    pageLimit: number;
  };
  /** Ops-facing auth (bearer token + read-only community keys). */
  ops: {
    apiToken: string;
    communityApiKeys: string[];
  };
  /** Admin-only API key (x-api-key header). */
  adminApiKey: string;
  /** Community-scoped API key records accepted on read-only endpoints. */
  communityApiKeys: Array<{
    key: string;
    scope: "community";
    contact: string;
    rateLimitPerMinute: number;
    createdAt: string;
  }>;
  /** Named throttling tiers consumed by ThrottlerModule. */
  throttle: {
    upstream: { ttl: number; limit: number };
    chain: { ttl: number; limit: number };
    default: { ttl: number; limit: number };
    catalog: { ttl: number; limit: number };
  };
  /** Pending off-chain policies that never get submitted expire after this many ms. */
  policyPendingTtlMs: number;
}

export default (): AppConfig => ({
  port: parseInt(process.env.PORT || "4001", 10),
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:3000",
  database: {
    url: process.env.DATABASE_URL || "postgres://refract:refract@localhost:5432/refract",
  },
  redis: {
    url: process.env.REDIS_URL || "redis://localhost:6379",
  },
  stellar: {
    network: process.env.STELLAR_NETWORK || "testnet",
    sorobanRpcUrl: process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org",
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015",
    poolContractId: process.env.REFRACT_POOL_CONTRACT_ID || "",
    policyContractId: process.env.REFRACT_POLICY_CONTRACT_ID || "",
    oracleContractId: process.env.REFRACT_ORACLE_CONTRACT_ID || "",
    relayerSecret: process.env.ORACLE_RELAYER_SECRET || "",
  },
  confirmation: {
    initialIntervalMs: parseInt(process.env.CONFIRMATION_INITIAL_INTERVAL_MS || "400", 10),
    backoffMultiplier: parseFloat(process.env.CONFIRMATION_BACKOFF_MULTIPLIER || "1.8"),
    maxIntervalMs: parseInt(process.env.CONFIRMATION_MAX_INTERVAL_MS || "8000", 10),
    deadlineMs: parseInt(process.env.CONFIRMATION_DEADLINE_MS || "30000", 10),
    jitterRatio: parseFloat(process.env.CONFIRMATION_JITTER_RATIO || "0.2"),
    settlementDeadlineMs: parseInt(process.env.CONFIRMATION_SETTLEMENT_DEADLINE_MS || "90000", 10),
    httpDeadlineMs: parseInt(process.env.CONFIRMATION_HTTP_DEADLINE_MS || "20000", 10),
  },
  oraclePublish: {
    mode: (process.env.ORACLE_PUBLISH_MODE as "every_poll" | "on_change") || "on_change",
    minIntervalMs: parseInt(process.env.ORACLE_PUBLISH_MIN_INTERVAL_MS || "300000", 10),
  },
  oracles: {
    coingeckoBaseUrl: process.env.COINGECKO_BASE_URL || "https://api.coingecko.com/api/v3",
    horizonUrl: process.env.STELLAR_HORIZON_URL || "https://horizon-testnet.stellar.org",
    defiLlamaBaseUrl: process.env.DEFILLAMA_BASE_URL || "https://api.llama.fi",
    // Placeholder "covered protocol" for the SmartContractRisk TVL-drop
    // check until Refract defines a real list of covered Soroban
    // protocols. Defaults to a large, consistently-tracked protocol so
    // the drop-detection logic has real data to run against.
    defiLlamaProtocolSlug: process.env.DEFILLAMA_PROTOCOL_SLUG || "aave",
    httpTimeoutMs: parseInt(process.env.ORACLE_HTTP_TIMEOUT_MS || "5000", 10),
  },
  fees: {
    ceilingStroops: process.env.FEE_CEILING_STROOPS || "1000000",
    statsTtlMs: parseInt(process.env.FEE_STATS_TTL_MS || "15000", 10),
    profiles: {
      moderate: {
        percentile: parseInt(process.env.FEE_MODERATE_PERCENTILE || "90", 10),
        multiplier: parseFloat(process.env.FEE_MODERATE_MULTIPLIER || "1.2"),
      },
      aggressive: {
        percentile: parseInt(process.env.FEE_AGGRESSIVE_PERCENTILE || "99", 10),
        multiplier: parseFloat(process.env.FEE_AGGRESSIVE_MULTIPLIER || "1.5"),
      },
    },
  },
  eventIndexer: {
    enabled: process.env.EVENT_INDEXER_ENABLED !== "false",
    pollIntervalMs: parseInt(process.env.EVENT_INDEXER_POLL_INTERVAL_MS || "5000", 10),
    lagAlertLedgers: parseInt(process.env.EVENT_INDEXER_LAG_ALERT_LEDGERS || "7200", 10),
    pageLimit: parseInt(process.env.EVENT_INDEXER_PAGE_LIMIT || "200", 10),
  },
  ops: {
    apiToken: process.env.OPS_API_TOKEN || "",
    communityApiKeys: (process.env.COMMUNITY_API_KEYS || "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  },
  adminApiKey: process.env.ADMIN_API_KEY || "",
  communityApiKeys: [],
  throttle: {
    upstream: {
      ttl: parseInt(process.env.THROTTLE_UPSTREAM_TTL_MS || "60000", 10),
      limit: parseInt(process.env.THROTTLE_UPSTREAM_LIMIT || "60", 10),
    },
    chain: {
      ttl: parseInt(process.env.THROTTLE_CHAIN_TTL_MS || "60000", 10),
      limit: parseInt(process.env.THROTTLE_CHAIN_LIMIT || "20", 10),
    },
    default: {
      ttl: parseInt(process.env.THROTTLE_DEFAULT_TTL_MS || "60000", 10),
      limit: parseInt(process.env.THROTTLE_DEFAULT_LIMIT || "600", 10),
    },
    catalog: {
      ttl: parseInt(process.env.THROTTLE_CATALOG_TTL_MS || "60000", 10),
      limit: parseInt(process.env.THROTTLE_CATALOG_LIMIT || "300", 10),
    },
  },
  policyPendingTtlMs: parseInt(process.env.POLICY_PENDING_TTL_MS || "3600000", 10),
});
