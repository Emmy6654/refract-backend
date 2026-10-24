import { OracleReading } from "./oracle-reading";
import {
  InMemoryReadingBus,
  ORACLE_LATEST_KEY,
  ORACLE_READINGS_CHANNEL,
  RedisLike,
  RedisReadingBus,
  createReadingBus,
  decodeReading,
  encodeReading,
} from "./reading-bus";
import { TrustTier } from "./consensus/consensus";

function reading(overrides: Partial<OracleReading> = {}): OracleReading {
  return {
    coverageType: "StablecoinDepeg",
    type: "oracle_update",
    value: 0.97,
    threshold: 0.95,
    severity: "medium",
    message: "USDC slipping",
    ...overrides,
  };
}

/** In-process stand-in for a Redis server shared by several clients. */
class FakeRedisServer {
  hashes = new Map<string, Map<string, string>>();
  subscribers = new Set<FakeRedis>();
  client(): FakeRedis {
    return new FakeRedis(this);
  }
}

class FakeRedis implements RedisLike {
  private listeners: Array<(channel: string, message: string) => void> = [];
  channels = new Set<string>();
  quitCalled = false;
  constructor(private readonly server: FakeRedisServer) {}

  async hset(key: string, field: string, value: string) {
    if (!this.server.hashes.has(key)) this.server.hashes.set(key, new Map());
    this.server.hashes.get(key)!.set(field, value);
    return 1;
  }
  async hgetall(key: string) {
    return Object.fromEntries(this.server.hashes.get(key) ?? []);
  }
  async publish(channel: string, message: string) {
    for (const sub of this.server.subscribers) {
      if (sub.channels.has(channel)) sub.listeners.forEach((l) => l(channel, message));
    }
    return 1;
  }
  async subscribe(channel: string) {
    this.channels.add(channel);
    this.server.subscribers.add(this);
    return 1;
  }
  async unsubscribe(channel: string) {
    this.channels.delete(channel);
    return 1;
  }
  on(_event: "message", listener: (channel: string, message: string) => void) {
    this.listeners.push(listener);
    return this;
  }
  off(_event: "message", listener: (channel: string, message: string) => void) {
    this.listeners = this.listeners.filter((l) => l !== listener);
    return this;
  }
  async quit() {
    this.quitCalled = true;
    return "OK";
  }
}

describe("reading wire format", () => {
  it("round-trips readings, including provenance", () => {
    const r = reading({
      provenance: { trustTier: TrustTier.Corroborated, agreeingSources: 2, decisionId: "00000000000000ff", sourceTimestamp: 1 },
    });
    expect(decodeReading(encodeReading(r))).toEqual(r);
  });

  it.each([
    ["not JSON", "{"],
    ["wrong version", JSON.stringify({ v: 2, reading: reading() })],
    ["missing reading", JSON.stringify({ v: 1 })],
    ["non-finite value", JSON.stringify({ v: 1, reading: { ...reading(), value: null } })],
    ["unknown severity", JSON.stringify({ v: 1, reading: { ...reading(), severity: "panic" } })],
  ])("rejects %s", (_label, raw) => {
    expect(decodeReading(raw)).toBeNull();
  });
});

describe("InMemoryReadingBus", () => {
  it("delivers to subscribers and keeps the latest reading per coverage type", async () => {
    const bus = new InMemoryReadingBus();
    const seen: OracleReading[] = [];
    const unsubscribe = await bus.subscribe((r) => seen.push(r));

    await bus.publishAll([reading({ value: 0.98 }), reading({ value: 0.97 }), reading({ coverageType: "FlightDelay", value: 200 })]);
    await unsubscribe();
    await bus.publish(reading({ value: 0.5 }));

    expect(seen.map((r) => r.value)).toEqual([0.98, 0.97, 200]);
    expect((await bus.latest()).map((r) => [r.coverageType, r.value])).toEqual([
      ["StablecoinDepeg", 0.5],
      ["FlightDelay", 200],
    ]);
  });

  it("refuses to publish malformed readings", async () => {
    await expect(new InMemoryReadingBus().publish(reading({ value: NaN }))).rejects.toThrow(/malformed/);
  });
});

describe("RedisReadingBus", () => {
  it("carries readings from a worker bus to an API bus through Redis", async () => {
    const server = new FakeRedisServer();
    const worker = new RedisReadingBus(server.client(), server.client());
    const api = new RedisReadingBus(server.client(), server.client());

    const seen: OracleReading[] = [];
    await api.subscribe((r) => seen.push(r));
    await worker.publish(reading());

    expect(seen).toEqual([reading()]);
    expect(await api.latest()).toEqual([reading()]);
    expect(server.hashes.get(ORACLE_LATEST_KEY)?.has("StablecoinDepeg")).toBe(true);
  });

  it("drops malformed messages instead of passing them to handlers", async () => {
    const server = new FakeRedisServer();
    const api = new RedisReadingBus(server.client(), server.client());
    const handler = jest.fn();
    await api.subscribe(handler);

    await server.client().publish(ORACLE_READINGS_CHANNEL, "garbage");
    await server.client().hset(ORACLE_LATEST_KEY, "X", "garbage");

    expect(handler).not.toHaveBeenCalled();
    expect(await api.latest()).toEqual([]);
  });

  it("closes both connections", async () => {
    const server = new FakeRedisServer();
    const commands = server.client();
    const subscriber = server.client();
    const bus = new RedisReadingBus(commands, subscriber);
    await bus.subscribe(() => undefined);
    await bus.close();
    expect(commands.quitCalled && subscriber.quitCalled).toBe(true);
    expect(subscriber.channels.size).toBe(0);
  });
});

describe("createReadingBus", () => {
  const connect = () => new FakeRedisServer().client();

  it("uses Redis whenever it is configured", () => {
    expect(createReadingBus("api", { REDIS_URL: "redis://x" }, connect)).toBeInstanceOf(RedisReadingBus);
    expect(createReadingBus("all", { REDIS_HOST: "x" }, connect)).toBeInstanceOf(RedisReadingBus);
  });

  it("falls back to in-memory for single-process and sandbox runs", () => {
    expect(createReadingBus("all", {}, connect)).toBeInstanceOf(InMemoryReadingBus);
    expect(createReadingBus("all", { SANDBOX_MODE: "true", REDIS_URL: "redis://x" }, connect)).toBeInstanceOf(
      InMemoryReadingBus
    );
  });

  it.each(["api", "worker"] as const)("fails fast when PROCESS_ROLE=%s has no Redis", (role) => {
    expect(() => createReadingBus(role, {}, connect)).toThrow(/requires REDIS_URL/);
  });
});
