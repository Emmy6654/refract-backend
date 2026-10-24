/**
 * Typed application configuration, loaded once by Nest's ConfigModule.
 *
 * Kept as a single factory function (rather than scattered `process.env`
 * reads) so every consumer gets the same parsed/defaulted values and the
 * shape is documented in one place. See `.env.example` for the full list
 * of variables this reads.
 */
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
    feedLatencyBudgetsMs?: Record<string, number>;
  };
  fees: {
    statsTtlMs: number;
    ceilingStroops: string;
    profiles: Record<FeeProfileName, { percentile: number; multiplier: number }>;
  };
  eventIndexer: {
    enabled: boolean;
    pollIntervalMs: number;
    contractId: string;
  };
  adminApiKey: string;
  communityApiKeys: string[];
  ops: {
    apiToken: string;
    communityApiKeys: string[];
  };
  oracleTrustMode: "strict" | "quorum" | "development";
  /** Pending off-chain policies that never get submitted expire after this many ms. */
  policyPendingTtlMs: number;
}

export type FeeProfileName = "moderate" | "aggressive";

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

function readBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export default (): AppConfig => {
  const network = (process.env.STELLAR_NETWORK || "testnet").toLowerCase();
  const selected = NETWORK_CONFIG[network];
  if (!selected) {
    throw new Error("expected testnet, futurenet, or mainnet");
  }

  const suffix = network.toUpperCase();
  const networkSpecificPoolId = process.env[`REFRACT_POOL_CONTRACT_ID_${suffix}`];
  const networkSpecificPolicyId = process.env[`REFRACT_POLICY_CONTRACT_ID_${suffix}`];
  const networkSpecificOracleId = process.env[`REFRACT_ORACLE_CONTRACT_ID_${suffix}`];

  return {
    port: parseInt(process.env.PORT || "4001", 10),
    frontendUrl: process.env.FRONTEND_URL || "http://localhost:3000",
    database: {
      url: process.env.DATABASE_URL || "postgres://refract:refract@localhost:5432/refract",
      poolMax: parseInt(process.env.DB_POOL_MAX || "10", 10),
      poolMin: parseInt(process.env.DB_POOL_MIN || "2", 10),
      poolIdleTimeoutMs: parseInt(process.env.DB_POOL_IDLE_TIMEOUT_MS || "30000", 10),
      poolAcquireTimeoutMs: parseInt(process.env.DB_POOL_ACQUIRE_TIMEOUT_MS || "5000", 10),
      statementTimeoutMs: parseInt(process.env.DB_STATEMENT_TIMEOUT_MS || "30000", 10),
      connectRetries: parseInt(process.env.DB_CONNECT_RETRIES || "5", 10),
      connectRetryDelayMs: parseInt(process.env.DB_CONNECT_RETRY_DELAY_MS || "1000", 10),
    },
    redis: {
      url: process.env.REDIS_URL || "redis://localhost:6379",
    },
    stellar: {
      network,
      sorobanRpcUrl: process.env.SOROBAN_RPC_URL || selected.sorobanRpcUrl,
      horizonUrl: selected.horizonUrl,
      networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE || selected.networkPassphrase,
      poolContractId: networkSpecificPoolId || process.env.REFRACT_POOL_CONTRACT_ID || "",
      policyContractId: networkSpecificPolicyId || process.env.REFRACT_POLICY_CONTRACT_ID || "",
      oracleContractId: networkSpecificOracleId || process.env.REFRACT_ORACLE_CONTRACT_ID || "",
      relayerSecret: process.env.ORACLE_RELAYER_SECRET || "",
      relayerSecretId: process.env.ORACLE_RELAYER_SECRET_ID || "",
      relayerSecretRegion: process.env.ORACLE_RELAYER_SECRET_REGION || "us-east-1",
      validateOnChain: readBool(process.env.VALIDATE_ON_CHAIN, false),
      requireNetwork: readBool(process.env.REQUIRE_NETWORK, false),
      validateTimeoutMs: parseInt(process.env.VALIDATE_TIMEOUT_MS || "5000", 10),
      relayer: {
        feeMultiplier: parseFloat(process.env.RELAYER_FEE_MULTIPLIER || "1.2"),
        feeCeiling: parseInt(process.env.RELAYER_FEE_CEILING || "1000000", 10),
        idleResyncMs: parseInt(process.env.RELAYER_IDLE_RESYNC_MS || "30000", 10),
        minBalance: parseInt(process.env.RELAYER_MIN_BALANCE || "50000000", 10),
        maxAttempts: parseInt(process.env.RELAYER_MAX_ATTEMPTS || "3", 10),
      },
      eventIndexer: {
        enabled: readBool(process.env.EVENT_INDEXER_ENABLED, false),
        pollIntervalMs: parseInt(process.env.EVENT_INDEXER_POLL_INTERVAL_MS || "5000", 10),
        lagAlertLedgers: parseInt(process.env.EVENT_INDEXER_LAG_ALERT_LEDGERS || "100", 10),
        pageLimit: parseInt(process.env.EVENT_INDEXER_PAGE_LIMIT || "100", 10),
      },
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
      horizonUrl: process.env.STELLAR_HORIZON_URL || selected.horizonUrl,
      defiLlamaBaseUrl: process.env.DEFILLAMA_BASE_URL || "https://api.llama.fi",
      // Placeholder "covered protocol" for the SmartContractRisk TVL-drop
      // check until Refract defines a real list of covered Soroban
      // protocols. Defaults to a large, consistently-tracked protocol so
      // the drop-detection logic has real data to run against.
      defiLlamaProtocolSlug: process.env.DEFILLAMA_PROTOCOL_SLUG || "aave",
      httpTimeoutMs: parseInt(process.env.ORACLE_HTTP_TIMEOUT_MS || "5000", 10),
      feedLatencyBudgetsMs: parseFeedBudgets(process.env.ORACLE_FEED_LATENCY_BUDGETS_MS),
    },
    fees: {
      statsTtlMs: parseInt(process.env.FEE_STATS_TTL_MS || "30000", 10),
      ceilingStroops: process.env.FEE_CEILING_STROOPS || "10000000",
      profiles: {
        moderate: {
          percentile: parseInt(process.env.FEE_MODERATE_PERCENTILE || "50", 10),
          multiplier: parseFloat(process.env.FEE_MODERATE_MULTIPLIER || "1.2"),
        },
        aggressive: {
          percentile: parseInt(process.env.FEE_AGGRESSIVE_PERCENTILE || "90", 10),
          multiplier: parseFloat(process.env.FEE_AGGRESSIVE_MULTIPLIER || "1.5"),
        },
      },
    },
    eventIndexer: {
      enabled: (process.env.EVENT_INDEXER_ENABLED || "false") === "true",
      pollIntervalMs: parseInt(process.env.EVENT_INDEXER_POLL_INTERVAL_MS || "5000", 10),
      contractId: process.env.REFRACT_POOL_CONTRACT_ID || "",
    },
    adminApiKey: process.env.ADMIN_API_KEY || "",
    communityApiKeys: parseCsv(process.env.COMMUNITY_API_KEYS),
    ops: {
      apiToken: process.env.OPS_API_TOKEN || "",
      communityApiKeys: parseCsv(process.env.COMMUNITY_API_KEYS),
    },
    oracleTrustMode: parseTrustMode(process.env.ORACLE_TRUST_MODE),
    policyPendingTtlMs: parseInt(process.env.POLICY_PENDING_TTL_MS || "3600000", 10),
  };
};

export function isSandboxMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.SANDBOX_MODE ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

export function assertSandboxSafety(env: NodeJS.ProcessEnv = process.env): void {
  if (isSandboxMode(env) && (env.NODE_ENV ?? "").trim().toLowerCase() === "production") {
    throw new Error("SANDBOX_MODE is not allowed when NODE_ENV=production");
  }
}

function parseCsv(value?: string): string[] {
  return (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parseFeedBudgets(value?: string): Record<string, number> | undefined {
  if (!value) return undefined;
  let result: unknown;
  try {
    result = JSON.parse(value);
  } catch {
    throw new Error("ORACLE_FEED_LATENCY_BUDGETS_MS must be valid JSON");
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("ORACLE_FEED_LATENCY_BUDGETS_MS must be a JSON object");
  }
  for (const [feed, budget] of Object.entries(result)) {
    if (!Number.isInteger(budget) || Number(budget) <= 0) {
      throw new Error(`Latency budget for ${feed} must be a positive integer`);
    }
  }
  return result as Record<string, number>;
}

function parseTrustMode(value?: string): AppConfig["oracleTrustMode"] {
  if (value === undefined || value === "") return "strict";
  if (value === "strict" || value === "quorum" || value === "development") return value;
  throw new Error("ORACLE_TRUST_MODE must be strict, quorum, or development");
}
