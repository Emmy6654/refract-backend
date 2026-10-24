export type FeeProfileName = "moderate" | "aggressive";

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
    poolMax: number;
    poolMin: number;
    poolIdleTimeoutMs: number;
    poolAcquireTimeoutMs: number;
    statementTimeoutMs: number;
    connectRetries: number;
    connectRetryDelayMs: number;
  };
  redis: {
    url: string;
  };
  stellar: {
    network: string;
    sorobanRpcUrl: string;
    sorobanRpcUrls: string[];
    eventStartLedger: number;
    horizonUrl: string;
    networkPassphrase: string;
    poolContractId: string;
    policyContractId: string;
    oracleContractId: string;
    relayerSecret: string;
    relayerSecretId?: string;
    relayerSecretRegion?: string;
    validateOnChain?: boolean;
    requireNetwork?: boolean;
    validateTimeoutMs?: number;
    relayer?: {
      feeMultiplier: number;
      feeCeiling: number;
      idleResyncMs: number;
      minBalance: number;
      maxAttempts: number;
    };
    eventIndexer?: {
      enabled: boolean;
      pollIntervalMs: number;
      lagAlertLedgers: number;
      pageLimit: number;
    };
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

const NETWORK_CONFIG: Record<string, { sorobanRpcUrl: string; horizonUrl: string; networkPassphrase: string }> = {
  testnet: {
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
  },
  futurenet: {
    sorobanRpcUrl: "https://soroban-futurenet.stellar.org",
    horizonUrl: "https://horizon-futurenet.stellar.org",
    networkPassphrase: "Test SDF Future Network ; October 2022",
  },
  mainnet: {
    sorobanRpcUrl: "https://soroban-rpc.mainnet.stellar.org",
    horizonUrl: "https://horizon.stellar.org",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
  },
};

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function readBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export default (): AppConfig => {
  const network = (process.env.STELLAR_NETWORK ?? "testnet").trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(NETWORK_CONFIG, network)) {
    throw new Error("STELLAR_NETWORK expected testnet, futurenet, or mainnet");
  }
  const selectedNetwork = NETWORK_CONFIG[network];
  const suffix = network.toUpperCase();
  const env = process.env;

  return {
    port: numberFromEnv("PORT", 4001),
    frontendUrl: env.FRONTEND_URL ?? "http://localhost:3000",
    database: {
      url: env.DATABASE_URL ?? "postgres://localhost:5432/refract",
      poolMax: numberFromEnv("DB_POOL_MAX", 10),
      poolMin: numberFromEnv("DB_POOL_MIN", 2),
      poolIdleTimeoutMs: numberFromEnv("DB_POOL_IDLE_TIMEOUT_MS", 30_000),
      poolAcquireTimeoutMs: numberFromEnv("DB_POOL_ACQUIRE_TIMEOUT_MS", 5_000),
      statementTimeoutMs: numberFromEnv("DB_STATEMENT_TIMEOUT_MS", 30_000),
      connectRetries: numberFromEnv("DB_CONNECT_RETRIES", 5),
      connectRetryDelayMs: numberFromEnv("DB_CONNECT_RETRY_DELAY_MS", 1_000),
    },
    redis: { url: env.REDIS_URL ?? "redis://localhost:6379" },
    stellar: {
      network,
      sorobanRpcUrl: selectedNetwork.sorobanRpcUrl,
      sorobanRpcUrls: (env.SOROBAN_RPC_URLS ?? selectedNetwork.sorobanRpcUrl)
        .split(",")
        .map((url) => url.trim())
        .filter(Boolean),
      eventStartLedger: numberFromEnv("EVENT_START_LEDGER", 1),
      horizonUrl: selectedNetwork.horizonUrl,
      networkPassphrase: selectedNetwork.networkPassphrase,
      poolContractId: env[`REFRACT_POOL_CONTRACT_ID_${suffix}`] ?? env.REFRACT_POOL_CONTRACT_ID ?? "",
      policyContractId: env[`REFRACT_POLICY_CONTRACT_ID_${suffix}`] ?? env.REFRACT_POLICY_CONTRACT_ID ?? "",
      oracleContractId: env[`REFRACT_ORACLE_CONTRACT_ID_${suffix}`] ?? env.REFRACT_ORACLE_CONTRACT_ID ?? "",
      relayerSecret: env.ORACLE_RELAYER_SECRET ?? "",
      relayerSecretId: env.ORACLE_RELAYER_SECRET_ID ?? "",
      relayerSecretRegion: env.ORACLE_RELAYER_SECRET_REGION ?? "us-east-1",
      validateOnChain: readBool(env.STELLAR_VALIDATE_ONCHAIN ?? env.VALIDATE_ON_CHAIN, false),
      requireNetwork: readBool(env.STELLAR_REQUIRE_NETWORK ?? env.REQUIRE_NETWORK, false),
      validateTimeoutMs: numberFromEnv("STELLAR_VALIDATE_TIMEOUT_MS", numberFromEnv("VALIDATE_TIMEOUT_MS", 5_000)),
      relayer: {
        feeMultiplier: numberFromEnv("RELAYER_FEE_MULTIPLIER", 1.2),
        feeCeiling: numberFromEnv("RELAYER_FEE_CEILING", 1_000_000),
        idleResyncMs: numberFromEnv("RELAYER_IDLE_RESYNC_MS", 30_000),
        minBalance: numberFromEnv("RELAYER_MIN_BALANCE", 50_000_000),
        maxAttempts: numberFromEnv("RELAYER_MAX_ATTEMPTS", 3),
      },
      eventIndexer: {
        enabled: readBool(env.EVENT_INDEXER_ENABLED, false),
        pollIntervalMs: numberFromEnv("EVENT_INDEXER_POLL_INTERVAL_MS", 5_000),
        lagAlertLedgers: numberFromEnv("EVENT_INDEXER_LAG_ALERT_LEDGERS", 100),
        pageLimit: numberFromEnv("EVENT_INDEXER_PAGE_LIMIT", 100),
      },
    },
    confirmation: {
      initialIntervalMs: numberFromEnv("CONFIRMATION_INITIAL_INTERVAL_MS", 400),
      backoffMultiplier: numberFromEnv("CONFIRMATION_BACKOFF_MULTIPLIER", 1.8),
      maxIntervalMs: numberFromEnv("CONFIRMATION_MAX_INTERVAL_MS", 8_000),
      deadlineMs: numberFromEnv("CONFIRMATION_DEADLINE_MS", 30_000),
      jitterRatio: numberFromEnv("CONFIRMATION_JITTER_RATIO", 0.2),
      settlementDeadlineMs: numberFromEnv("CONFIRMATION_SETTLEMENT_DEADLINE_MS", 90_000),
      httpDeadlineMs: numberFromEnv("CONFIRMATION_HTTP_DEADLINE_MS", 20_000),
    },
    oraclePublish: {
      mode: env.ORACLE_PUBLISH_MODE === "every_poll" ? "every_poll" : "on_change",
      minIntervalMs: numberFromEnv("ORACLE_PUBLISH_MIN_INTERVAL_MS", 300_000),
    },
    oracles: {
      coingeckoBaseUrl: env.COINGECKO_BASE_URL ?? "https://api.coingecko.com/api/v3",
      horizonUrl: selectedNetwork.horizonUrl,
      defiLlamaBaseUrl: env.DEFILLAMA_BASE_URL ?? "https://api.llama.fi",
      // Placeholder "covered protocol" for the SmartContractRisk TVL-drop
      // check until Refract defines a real list of covered Soroban
      // protocols. Defaults to a large, consistently-tracked protocol so
      // the drop-detection logic has real data to run against.
      defiLlamaProtocolSlug: env.DEFILLAMA_PROTOCOL_SLUG ?? "aave",
      httpTimeoutMs: numberFromEnv("ORACLE_HTTP_TIMEOUT_MS", 5_000),
    },
    fees: {
      statsTtlMs: numberFromEnv("FEE_STATS_TTL_MS", 15_000),
      ceilingStroops: String(numberFromEnv("FEE_CEILING_STROOPS", 10_000_000)),
      profiles: {
        moderate: {
          percentile: numberFromEnv("FEE_MODERATE_PERCENTILE", 90),
          multiplier: numberFromEnv("FEE_MODERATE_MULTIPLIER", 1.2),
        },
        aggressive: {
          percentile: numberFromEnv("FEE_AGGRESSIVE_PERCENTILE", 99),
          multiplier: numberFromEnv("FEE_AGGRESSIVE_MULTIPLIER", 1.5),
        },
      },
    },
    eventIndexer: {
      enabled: readBool(env.EVENT_INDEXER_ENABLED, false),
      pollIntervalMs: numberFromEnv("EVENT_INDEXER_POLL_INTERVAL_MS", 5_000),
      lagAlertLedgers: numberFromEnv("EVENT_INDEXER_LAG_ALERT_LEDGERS", 100),
      pageLimit: numberFromEnv("EVENT_INDEXER_PAGE_LIMIT", 100),
    },
    ops: {
      apiToken: env.OPS_API_TOKEN ?? "",
      communityApiKeys: (env.COMMUNITY_API_KEYS ?? "")
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean),
    },
    adminApiKey: env.ADMIN_API_KEY ?? "",
    communityApiKeys: [],
    throttle: {
      upstream: { ttl: 60_000, limit: 30 },
      chain: { ttl: 60_000, limit: 10 },
      default: { ttl: 60_000, limit: 100 },
      catalog: { ttl: 60_000, limit: 200 },
    },
    policyPendingTtlMs: numberFromEnv("POLICY_PENDING_TTL_MS", 3_600_000),
  };
};
