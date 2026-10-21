/**
 * Typed application configuration, loaded once by Nest's ConfigModule.
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
    relayerSecret?: string;
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
  oracles: {
    coingeckoBaseUrl: string;
    horizonUrl: string;
    defiLlamaBaseUrl: string;
    defiLlamaProtocolSlug: string;
    httpTimeoutMs: number;
  };
  confirmation?: {
    initialIntervalMs: number;
    backoffMultiplier: number;
    maxIntervalMs: number;
    deadlineMs: number;
    jitterRatio: number;
    settlementDeadlineMs: number;
    httpDeadlineMs: number;
  };
  oraclePublish?: {
    mode: "every_poll" | "on_change";
    minIntervalMs: number;
  };
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
      url: process.env.DATABASE_URL || "postgresql://localhost:5432/refract",
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
      sorobanRpcUrl: selected.sorobanRpcUrl,
      horizonUrl: selected.horizonUrl,
      networkPassphrase: selected.networkPassphrase,
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
    oracles: {
      coingeckoBaseUrl: process.env.COINGECKO_BASE_URL || "https://api.coingecko.com/api/v3",
      horizonUrl: selected.horizonUrl,
      defiLlamaBaseUrl: process.env.DEFILLAMA_BASE_URL || "https://api.llama.fi",
      defiLlamaProtocolSlug: process.env.DEFILLAMA_PROTOCOL_SLUG || "aave",
      httpTimeoutMs: parseInt(process.env.ORACLE_HTTP_TIMEOUT_MS || "5000", 10),
    },
    confirmation: {
      initialIntervalMs: parseInt(process.env.CONFIRMATION_INITIAL_INTERVAL_MS || "10", 10),
      backoffMultiplier: parseFloat(process.env.CONFIRMATION_BACKOFF_MULTIPLIER || "1.5"),
      maxIntervalMs: parseInt(process.env.CONFIRMATION_MAX_INTERVAL_MS || "50", 10),
      deadlineMs: parseInt(process.env.CONFIRMATION_DEADLINE_MS || "200", 10),
      jitterRatio: parseFloat(process.env.CONFIRMATION_JITTER_RATIO || "0"),
      settlementDeadlineMs: parseInt(process.env.CONFIRMATION_SETTLEMENT_DEADLINE_MS || "200", 10),
      httpDeadlineMs: parseInt(process.env.CONFIRMATION_HTTP_DEADLINE_MS || "100", 10),
    },
    oraclePublish: {
      mode: (process.env.ORACLE_PUBLISH_MODE || "every_poll") as "every_poll" | "on_change",
      minIntervalMs: parseInt(process.env.ORACLE_PUBLISH_MIN_INTERVAL_MS || "0", 10),
    },
  };
};
