/**
 * Typed application configuration, loaded once by Nest's ConfigModule.
 *
 * Kept as a single factory function (rather than scattered `process.env`
 * reads) so every consumer gets the same parsed/defaulted values and the
 * shape is documented in one place. See `.env.example` for the full list
 * of variables this reads.
 *
 * `AppConfig` is inferred from the Zod schema in `./env.schema` so the
 * TypeScript type and the runtime validation cannot drift.
 */
import { z } from "zod";
import { validateEnv } from "./env.schema";

const NETWORK_CONFIG: Record<
  string,
  { sorobanRpcUrl: string; horizonUrl: string; networkPassphrase: string }
> = {
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

const appConfigSchema = z.object({
  port: z.number().int().min(1).max(65535),
  frontendUrl: z.string().url(),
  database: z.object({
    url: z.string().url(),
    poolMax: z.number().int(),
    poolMin: z.number().int(),
    poolIdleTimeoutMs: z.number().int(),
    poolAcquireTimeoutMs: z.number().int(),
    statementTimeoutMs: z.number().int(),
    connectRetries: z.number().int(),
    connectRetryDelayMs: z.number().int(),
  }),
  redis: z.object({ url: z.string().url() }),
  stellar: z.object({
    network: z.string(),
    sorobanRpcUrl: z.string().url(),
    horizonUrl: z.string().url(),
    networkPassphrase: z.string(),
    poolContractId: z.string(),
    policyContractId: z.string(),
    oracleContractId: z.string(),
    relayerSecret: z.string(),
    relayerSecretId: z.string(),
    relayerSecretRegion: z.string(),
    validateOnChain: z.boolean(),
    requireNetwork: z.boolean(),
    validateTimeoutMs: z.number().int(),
    relayer: z.object({
      feeMultiplier: z.number(),
      feeCeiling: z.number().int(),
      idleResyncMs: z.number().int(),
      minBalance: z.number().int(),
      maxAttempts: z.number().int(),
    }),
    eventIndexer: z.object({
      enabled: z.boolean(),
      pollIntervalMs: z.number().int(),
      lagAlertLedgers: z.number().int(),
      pageLimit: z.number().int(),
    }),
  }),
  oracles: z.object({
    coingeckoBaseUrl: z.string().url(),
    horizonUrl: z.string().url(),
    defiLlamaBaseUrl: z.string().url(),
    defiLlamaProtocolSlug: z.string(),
    httpTimeoutMs: z.number().int().min(100).max(120_000),
  }),
  confirmation: z.object({
    initialIntervalMs: z.number().int(),
    backoffMultiplier: z.number(),
    maxIntervalMs: z.number().int(),
    deadlineMs: z.number().int(),
    jitterRatio: z.number(),
    settlementDeadlineMs: z.number().int(),
    httpDeadlineMs: z.number().int(),
  }),
  oraclePublish: z.object({
    mode: z.enum(["every_poll", "on_change"]),
    minIntervalMs: z.number().int(),
  }),
  throttle: z.object({
    /**
     * Named throttling tiers, each expressed as `{ limit, ttl }` where
     * `limit` is the max number of requests allowed per `ttl` window
     * (milliseconds). Consumed by `ThrottlerModule.forRootAsync` and
     * referenced by name from `@Throttle({ ... })` route overrides.
     */
    tiers: z.object({
      /** Upstream-proxying reads (e.g. GET /oracle/status). */
      strict: z.object({ limit: z.number().int(), ttl: z.number().int() }),
      /** Chain-writing posts (e.g. /tx/submit, /policies/buy). */
      chainWrite: z.object({ limit: z.number().int(), ttl: z.number().int() }),
      /** Ordinary database-backed reads. */
      moderate: z.object({ limit: z.number().int(), ttl: z.number().int() }),
      /** Static catalog routes (e.g. /quotes/coverage-types). */
      generous: z.object({ limit: z.number().int(), ttl: z.number().int() }),
    }),
    /**
     * Whether to trust `X-Forwarded-For` from a fronting proxy. Must be
     * set deliberately (never implicitly) so IP-based limiting does not
     * collapse every caller onto the load balancer's address.
     */
    trustProxy: z.boolean(),
  }),
});

export type AppConfig = z.infer<typeof appConfigSchema>;

export default (): AppConfig => {
  const env = validateEnv(process.env);

  const requireChainConfig = env.REQUIRE_CHAIN_CONFIG === true;
  const chainKeys = [
    "REFRACT_POOL_CONTRACT_ID",
    "REFRACT_POLICY_CONTRACT_ID",
    "REFRACT_ORACLE_CONTRACT_ID",
    "ORACLE_RELAYER_SECRET",
  ] as const;

  if (requireChainConfig) {
    const missing = chainKeys.filter((key) => !env[key]);
    if (missing.length > 0) {
      throw new Error(
        `Invalid environment configuration:\n${missing
          .map((key) => `  - ${key}: required when REQUIRE_CHAIN_CONFIG is set`)
          .join("\n")}`,
      );
    }
  }

  const network = (env.STELLAR_NETWORK ?? "testnet").toLowerCase();
  const selected = NETWORK_CONFIG[network];
  if (!selected) {
    throw new Error("expected testnet, futurenet, or mainnet");
  }

  const suffix = network.toUpperCase();
  const networkSpecificPoolId = env[`REFRACT_POOL_CONTRACT_ID_${suffix}`];
  const networkSpecificPolicyId = env[`REFRACT_POLICY_CONTRACT_ID_${suffix}`];
  const networkSpecificOracleId = env[`REFRACT_ORACLE_CONTRACT_ID_${suffix}`];

  return {
    port: env.PORT ?? 4001,
    frontendUrl: env.FRONTEND_URL ?? "http://localhost:3000",
    database: {
      url:
        env.DATABASE_URL ??
        "postgres://refract:refract@localhost:5432/refract",
      poolMax: env.DB_POOL_MAX ?? 10,
      poolMin: env.DB_POOL_MIN ?? 2,
      poolIdleTimeoutMs: env.DB_POOL_IDLE_TIMEOUT_MS ?? 30000,
      poolAcquireTimeoutMs: env.DB_POOL_ACQUIRE_TIMEOUT_MS ?? 5000,
      statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS ?? 30000,
      connectRetries: env.DB_CONNECT_RETRIES ?? 5,
      connectRetryDelayMs: env.DB_CONNECT_RETRY_DELAY_MS ?? 1000,
    },
    redis: {
      url: env.REDIS_URL ?? "redis://localhost:6379",
    },
    stellar: {
      network,
      sorobanRpcUrl: env.SOROBAN_RPC_URL ?? selected.sorobanRpcUrl,
      horizonUrl: env.STELLAR_HORIZON_URL ?? selected.horizonUrl,
      networkPassphrase:
        env.STELLAR_NETWORK_PASSPHRASE ?? selected.networkPassphrase,
      poolContractId:
        networkSpecificPoolId ?? env.REFRACT_POOL_CONTRACT_ID ?? "",
      policyContractId:
        networkSpecificPolicyId ?? env.REFRACT_POLICY_CONTRACT_ID ?? "",
      oracleContractId:
        networkSpecificOracleId ?? env.REFRACT_ORACLE_CONTRACT_ID ?? "",
      relayerSecret: env.ORACLE_RELAYER_SECRET ?? "",
      relayerSecretId: env.ORACLE_RELAYER_SECRET_ID ?? "",
      relayerSecretRegion: env.ORACLE_RELAYER_SECRET_REGION ?? "us-east-1",
      validateOnChain: env.VALIDATE_ON_CHAIN === true,
      requireNetwork: env.REQUIRE_NETWORK === true,
      validateTimeoutMs: env.VALIDATE_TIMEOUT_MS ?? 5000,
      relayer: {
        feeMultiplier: env.RELAYER_FEE_MULTIPLIER ?? 1.2,
        feeCeiling: env.RELAYER_FEE_CEILING ?? 1000000,
        idleResyncMs: env.RELAYER_IDLE_RESYNC_MS ?? 30000,
        minBalance: env.RELAYER_MIN_BALANCE ?? 50000000,
        maxAttempts: env.RELAYER_MAX_ATTEMPTS ?? 3,
      },
      eventIndexer: {
        enabled: env.EVENT_INDEXER_ENABLED === true,
        pollIntervalMs: env.EVENT_INDEXER_POLL_INTERVAL_MS ?? 5000,
        lagAlertLedgers: env.EVENT_INDEXER_LAG_ALERT_LEDGERS ?? 100,
        pageLimit: env.EVENT_INDEXER_PAGE_LIMIT ?? 100,
      },
    },
    oracles: {
      coingeckoBaseUrl:
        env.COINGECKO_BASE_URL ?? "https://api.coingecko.com/api/v3",
      horizonUrl: env.STELLAR_HORIZON_URL ?? selected.horizonUrl,
      defiLlamaBaseUrl: env.DEFILLAMA_BASE_URL ?? "https://api.llama.fi",
      // Placeholder "covered protocol" for the SmartContractRisk TVL-drop
      // check until Refract defines a real list of covered Soroban
      // protocols. Defaults to a large, consistently-tracked protocol so
      // the drop-detection logic has real data to run against.
      defiLlamaProtocolSlug: env.DEFILLAMA_PROTOCOL_SLUG ?? "aave",
      httpTimeoutMs: env.ORACLE_HTTP_TIMEOUT_MS ?? 5000,
    },
    confirmation: {
      initialIntervalMs: env.CONFIRMATION_INITIAL_INTERVAL_MS ?? 10,
      backoffMultiplier: env.CONFIRMATION_BACKOFF_MULTIPLIER ?? 1.5,
      maxIntervalMs: env.CONFIRMATION_MAX_INTERVAL_MS ?? 50,
      deadlineMs: env.CONFIRMATION_DEADLINE_MS ?? 200,
      jitterRatio: env.CONFIRMATION_JITTER_RATIO ?? 0,
      settlementDeadlineMs: env.CONFIRMATION_SETTLEMENT_DEADLINE_MS ?? 200,
      httpDeadlineMs: env.CONFIRMATION_HTTP_DEADLINE_MS ?? 100,
    },
    oraclePublish: {
      mode: env.ORACLE_PUBLISH_MODE ?? "every_poll",
      minIntervalMs: env.ORACLE_PUBLISH_MIN_INTERVAL_MS ?? 0,
    },
    throttle: {
      tiers: {
        strict: {
          limit: env.THROTTLE_STRICT_LIMIT ?? 10,
          ttl: env.THROTTLE_STRICT_TTL_MS ?? 60_000,
        },
        chainWrite: {
          limit: env.THROTTLE_CHAIN_WRITE_LIMIT ?? 5,
          ttl: env.THROTTLE_CHAIN_WRITE_TTL_MS ?? 60_000,
        },
        moderate: {
          limit: env.THROTTLE_MODERATE_LIMIT ?? 60,
          ttl: env.THROTTLE_MODERATE_TTL_MS ?? 60_000,
        },
        generous: {
          limit: env.THROTTLE_GENEROUS_LIMIT ?? 120,
          ttl: env.THROTTLE_GENEROUS_TTL_MS ?? 60_000,
        },
      },
      trustProxy: env.TRUST_PROXY === true,
    },
  };
};
