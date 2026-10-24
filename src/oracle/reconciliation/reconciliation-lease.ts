/**
 * A named, expiring lock so only one reconciler runs at a time, even with
 * several backend replicas. The TTL means a crashed holder cannot block
 * reconciliation forever.
 */
export interface ReconciliationLease {
  /** Returns true when `owner` now holds the lease. */
  acquire(name: string, owner: string, ttlMs: number): Promise<boolean>;
  /** Releases the lease only if `owner` still holds it. */
  release(name: string, owner: string): Promise<void>;
}

export const RECONCILIATION_LEASE = Symbol("RECONCILIATION_LEASE");

/** Single-process lease. Correct for one replica; use the Redis lease for more. */
export class InMemoryReconciliationLease implements ReconciliationLease {
  private readonly held = new Map<string, { owner: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async acquire(name: string, owner: string, ttlMs: number): Promise<boolean> {
    const current = this.held.get(name);
    if (current && current.expiresAt > this.now() && current.owner !== owner) return false;
    this.held.set(name, { owner, expiresAt: this.now() + ttlMs });
    return true;
  }

  async release(name: string, owner: string): Promise<void> {
    if (this.held.get(name)?.owner === owner) this.held.delete(name);
  }
}

/** The subset of ioredis this lease needs. */
export interface RedisLeaseClient {
  set(key: string, value: string, px: "PX", ttlMs: number, nx: "NX"): Promise<"OK" | null>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

const RELEASE_IF_OWNER = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/** Cross-replica lease: `SET key owner PX ttl NX`, released with compare-and-delete. */
export class RedisReconciliationLease implements ReconciliationLease {
  constructor(private readonly redis: RedisLeaseClient, private readonly prefix = "refract:lease:") {}

  async acquire(name: string, owner: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(this.prefix + name, owner, "PX", ttlMs, "NX");
    return result === "OK";
  }

  async release(name: string, owner: string): Promise<void> {
    await this.redis.eval(RELEASE_IF_OWNER, 1, this.prefix + name, owner);
  }
}
