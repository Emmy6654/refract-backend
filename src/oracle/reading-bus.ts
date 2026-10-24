import { EventEmitter } from "events";
import { Logger } from "@nestjs/common";
import Redis, { RedisOptions } from "ioredis";
import { OracleReading } from "./oracle-reading";
import { ProcessRole } from "../runtime/process-role";

/**
 * Carries oracle readings from the worker (which polls and evaluates
 * consensus) to the API (which serves reads and the WebSocket feed).
 *
 * The API never polls upstreams itself: it relays what the worker publishes
 * and answers "latest reading" queries from the shared store.
 */
export abstract class ReadingBus {
  abstract publish(reading: OracleReading): Promise<void>;
  /** Subscribe to new readings. Resolves to an unsubscribe function. */
  abstract subscribe(handler: (reading: OracleReading) => void): Promise<() => Promise<void>>;
  /** Most recent reading per coverage type. */
  abstract latest(): Promise<OracleReading[]>;
  abstract close(): Promise<void>;

  async publishAll(readings: readonly OracleReading[]): Promise<void> {
    for (const reading of readings) {
      await this.publish(reading);
    }
  }
}

export const ORACLE_READINGS_CHANNEL = "refract:oracle:readings";
export const ORACLE_LATEST_KEY = "refract:oracle:latest";

interface Envelope {
  v: 1;
  publishedAt: number;
  reading: OracleReading;
}

const SEVERITIES = new Set(["low", "medium", "high", "triggered"]);

/** Parse and validate a bus message. Returns null for anything malformed. */
export function decodeReading(raw: string): OracleReading | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const env = parsed as Partial<Envelope> | null;
  const r = env?.reading as Partial<OracleReading> | undefined;
  if (
    env?.v !== 1 ||
    !r ||
    typeof r.coverageType !== "string" ||
    r.type !== "oracle_update" ||
    typeof r.value !== "number" ||
    !Number.isFinite(r.value) ||
    typeof r.threshold !== "number" ||
    typeof r.message !== "string" ||
    !SEVERITIES.has(r.severity as string)
  ) {
    return null;
  }
  return r as OracleReading;
}

export function encodeReading(reading: OracleReading, publishedAt = Date.now()): string {
  const envelope: Envelope = { v: 1, publishedAt, reading };
  return JSON.stringify(envelope);
}

/** Single-process bus for PROCESS_ROLE=all, sandbox mode and tests. */
export class InMemoryReadingBus extends ReadingBus {
  private readonly emitter = new EventEmitter();
  private readonly latestByType = new Map<string, OracleReading>();

  async publish(reading: OracleReading): Promise<void> {
    // Round-trip through the wire format so in-memory and Redis behave the same.
    const decoded = decodeReading(encodeReading(reading));
    if (!decoded) throw new Error(`Refusing to publish malformed reading for ${reading.coverageType}`);
    this.latestByType.set(decoded.coverageType, decoded);
    this.emitter.emit("reading", decoded);
  }

  async subscribe(handler: (reading: OracleReading) => void): Promise<() => Promise<void>> {
    this.emitter.on("reading", handler);
    return async () => {
      this.emitter.off("reading", handler);
    };
  }

  async latest(): Promise<OracleReading[]> {
    return [...this.latestByType.values()];
  }

  async close(): Promise<void> {
    this.emitter.removeAllListeners();
  }
}

/** Subset of ioredis used here, so tests can pass a fake. */
export interface RedisLike {
  hset(key: string, field: string, value: string): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
  publish(channel: string, message: string): Promise<unknown>;
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: "message", listener: (channel: string, message: string) => void): unknown;
  off(event: "message", listener: (channel: string, message: string) => void): unknown;
  quit(): Promise<unknown>;
}

/**
 * Cross-process bus over Redis: latest readings in a hash, live updates via
 * pub/sub. Uses a separate connection for subscribing, as Redis requires.
 */
export class RedisReadingBus extends ReadingBus {
  private readonly logger = new Logger(RedisReadingBus.name);
  private subscribed = false;

  constructor(
    private readonly commands: RedisLike,
    private readonly subscriber: RedisLike
  ) {
    super();
  }

  async publish(reading: OracleReading): Promise<void> {
    const payload = encodeReading(reading);
    if (!decodeReading(payload)) {
      throw new Error(`Refusing to publish malformed reading for ${reading.coverageType}`);
    }
    // Store first so a subscriber that reacts to the message can read it back.
    await this.commands.hset(ORACLE_LATEST_KEY, reading.coverageType, payload);
    await this.commands.publish(ORACLE_READINGS_CHANNEL, payload);
  }

  async subscribe(handler: (reading: OracleReading) => void): Promise<() => Promise<void>> {
    const listener = (channel: string, message: string) => {
      if (channel !== ORACLE_READINGS_CHANNEL) return;
      const reading = decodeReading(message);
      if (!reading) {
        this.logger.warn("Dropping malformed oracle reading from Redis");
        return;
      }
      handler(reading);
    };
    this.subscriber.on("message", listener);
    if (!this.subscribed) {
      await this.subscriber.subscribe(ORACLE_READINGS_CHANNEL);
      this.subscribed = true;
    }
    return async () => {
      this.subscriber.off("message", listener);
    };
  }

  async latest(): Promise<OracleReading[]> {
    const all = await this.commands.hgetall(ORACLE_LATEST_KEY);
    return Object.values(all ?? {})
      .map(decodeReading)
      .filter((r): r is OracleReading => r !== null);
  }

  async close(): Promise<void> {
    if (this.subscribed) {
      await this.subscriber.unsubscribe(ORACLE_READINGS_CHANNEL).catch(() => undefined);
    }
    await Promise.allSettled([this.commands.quit(), this.subscriber.quit()]);
  }
}

export function redisOptionsFromEnv(env: NodeJS.ProcessEnv): { url?: string; options?: RedisOptions } | null {
  if (env.REDIS_URL) return { url: env.REDIS_URL };
  if (env.REDIS_HOST) {
    return {
      options: {
        host: env.REDIS_HOST,
        port: Number(env.REDIS_PORT ?? 6379),
        password: env.REDIS_PASSWORD || undefined,
      },
    };
  }
  return null;
}

/**
 * Pick the bus for this process. A split deployment (api / worker) needs
 * Redis, otherwise the API would never see the worker's readings — fail at
 * boot rather than serve a silently frozen feed.
 */
export function createReadingBus(
  role: ProcessRole,
  env: NodeJS.ProcessEnv = process.env,
  connect: (cfg: { url?: string; options?: RedisOptions }) => RedisLike = defaultConnect
): ReadingBus {
  const sandbox = (env.SANDBOX_MODE ?? "").toLowerCase() === "true";
  const redis = sandbox ? null : redisOptionsFromEnv(env);
  if (!redis) {
    if (role !== "all") {
      throw new Error(
        `PROCESS_ROLE=${role} requires REDIS_URL (or REDIS_HOST) so the API and worker can share oracle readings`
      );
    }
    return new InMemoryReadingBus();
  }
  return new RedisReadingBus(connect(redis), connect(redis));
}

function defaultConnect(cfg: { url?: string; options?: RedisOptions }): RedisLike {
  const client = cfg.url ? new Redis(cfg.url) : new Redis(cfg.options ?? {});
  client.on("error", (err: Error) => new Logger("ReadingBus").error(`Redis error: ${err.message}`));
  return client as unknown as RedisLike;
}
