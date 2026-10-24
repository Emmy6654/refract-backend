import { Injectable, Logger, OnApplicationShutdown, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { AppConfig } from "../config/configuration";

export const ORACLE_TTL = 55;

@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown {
  private readonly logger = new Logger(CacheService.name);
  private readonly client: Redis;
  private closed = false;

  constructor(configService: ConfigService<AppConfig, true>) {
    const configured = configService.get("redis", { infer: true });
    const url = process.env.REDIS_URL ?? configured.url;
    this.client = new Redis(url, { lazyConnect: false });
    this.client.on("error", (err) => this.logger.error(`Redis client error: ${err.message}`));
  }

  onModuleInit(): void {}

  async get<T>(key: string): Promise<T | null> {
    try {
      const value = await this.client.get(key);
      return value === null ? null : (JSON.parse(value) as T);
    } catch (error) {
      this.logger.warn(`Redis cache read failed for ${key}: ${this.errorMessage(error)}`);
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      if (ttlSeconds) await this.client.set(key, serialized, "EX", ttlSeconds);
      else await this.client.set(key, serialized);
    } catch (error) {
      this.logger.warn(`Redis cache write failed for ${key}: ${this.errorMessage(error)}`);
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.client.del(...keys);
    } catch (error) {
      this.logger.warn(`Redis cache delete failed: ${this.errorMessage(error)}`);
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

  /**
   * Gracefully close the Redis connection pool during application shutdown.
   * Called by Nest when `app.enableShutdownHooks()` is active and the process
   * receives SIGTERM/SIGINT, ensuring in-flight commands drain before exit.
   */
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
