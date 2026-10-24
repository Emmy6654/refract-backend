import { Injectable, Logger, OnApplicationShutdown, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { AppConfig } from "../config/configuration";

/**
 * CacheService — thin, typed wrapper around ioredis.
 *
 * Design goals
 * ------------
 * - Single Redis connection per process, shared across all consumers.
 * - Fail-open: every public method swallows Redis errors and falls back
 *   to the non-cached path so a Redis outage never brings down the API.
 * - `wrap<T>()` is the primary interface: "return cached value or run
 *   the loader, cache the result, return it."
 *
 * TTL conventions (seconds)
 * -------------------------
 * ORACLE_TTL   55 s — just under the 60 s scheduler interval so the
 *              HTTP endpoint always returns data that is at most one
 *              cycle stale without issuing a redundant upstream call.
 */
export const ORACLE_TTL = 55;

@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown {
  private readonly logger = new Logger(CacheService.name);
  private readonly client: Redis;
  private closed = false;

  constructor(private readonly configService: ConfigService<AppConfig, true>) {
    const configured = this.configService.get("redis", { infer: true });
    const url = process.env.REDIS_URL ?? configured.url;
    this.client = new Redis(url, {
      // Don't retry indefinitely — give up after 3 reconnection attempts
      // so a missing Redis doesn't stall startup.
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      lazyConnect: false,
    });

    this.client.on("connect", () => this.logger.log("Redis connected"));
    this.client.on("error", (err: Error) =>
      this.logger.warn(`Redis error (cache degraded): ${err.message}`)
    );
  }

  onModuleInit(): void {}

  /** Returns the parsed JSON value for `key`, or `null` on miss or error. */
  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (err) {
      this.logger.warn(`cache.get("${key}") failed: ${this.errorMessage(err)}`);
      return null;
    }
  }

  /** Serialises `value` to JSON and stores it under `key` for `ttlSeconds`. */
  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      if (ttlSeconds) await this.client.set(key, serialized, "EX", ttlSeconds);
      else await this.client.set(key, serialized);
    } catch (err) {
      this.logger.warn(`cache.set("${key}") failed: ${this.errorMessage(err)}`);
    }
  }

  /** Deletes one or more keys (best-effort). */
  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.client.del(...keys);
    } catch (err) {
      this.logger.warn(`cache.del(${keys.join(",")}) failed: ${this.errorMessage(err)}`);
    }
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === "PONG";
    } catch (error) {
      this.logger.warn(`Redis health check failed: ${this.errorMessage(error)}`);
      return false;
    }
  }

  isConnected(): boolean {
    return this.client.status === "ready";
  }

  /**
   * Cache-aside helper.
   *
   * Returns the cached value for `key` when present.  Otherwise calls
   * `loader`, stores the result for `ttlSeconds`, and returns it.
   * If either the cache read or write throws, the loader result is
   * returned without caching (fail-open).
   *
   * @example
   * const readings = await this.cacheService.wrap(
   *   "oracle:checkAll",
   *   ORACLE_TTL,
   *   () => this.runAllChecks()
   * );
   */
  async wrap<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const fresh = await loader();
    await this.set(key, fresh, ttlSeconds);
    return fresh;
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(
      `Closing Redis connection pool${signal ? ` (signal: ${signal})` : ''}...`,
    );
    await this.close();
  }

  private async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.client.quit();
    } catch (error) {
      this.logger.error(`Failed to close Redis connection: ${this.errorMessage(error)}`);
      this.client.disconnect();
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
