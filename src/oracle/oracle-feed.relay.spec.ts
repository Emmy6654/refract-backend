import { OracleFeedRelay } from "./oracle-feed.relay";
import { OracleGateway } from "./oracle.gateway";
import { OracleReading } from "./oracle-reading";
import { InMemoryReadingBus } from "./reading-bus";

function reading(overrides: Partial<OracleReading> = {}): OracleReading {
  return {
    coverageType: "MarketCrash",
    type: "oracle_update",
    value: -12,
    threshold: -20,
    severity: "high",
    message: "drawdown",
    ...overrides,
  };
}

describe("OracleFeedRelay", () => {
  const originalRole = process.env.PROCESS_ROLE;
  afterEach(() => {
    if (originalRole === undefined) delete process.env.PROCESS_ROLE;
    else process.env.PROCESS_ROLE = originalRole;
  });

  function setup() {
    const bus = new InMemoryReadingBus();
    const gateway = { broadcastAlert: jest.fn() } as unknown as OracleGateway;
    return { bus, gateway, relay: new OracleFeedRelay(bus, gateway) };
  }

  it("relays non-low readings published by the worker to WebSocket clients", async () => {
    process.env.PROCESS_ROLE = "api";
    const { bus, gateway, relay } = setup();
    await relay.onModuleInit();

    await bus.publish(reading());
    await bus.publish(reading({ coverageType: "FlightDelay", severity: "low" }));

    expect(gateway.broadcastAlert).toHaveBeenCalledTimes(1);
    expect(gateway.broadcastAlert).toHaveBeenCalledWith(reading());
    expect((await relay.latest()).map((r) => r.coverageType)).toEqual(["MarketCrash", "FlightDelay"]);
  });

  it("stops relaying after shutdown", async () => {
    process.env.PROCESS_ROLE = "api";
    const { bus, gateway, relay } = setup();
    await relay.onModuleInit();
    await relay.onModuleDestroy();

    await bus.publish(reading());
    expect(gateway.broadcastAlert).not.toHaveBeenCalled();
  });

  it("does not subscribe in a worker-only process", async () => {
    process.env.PROCESS_ROLE = "worker";
    const { bus, gateway, relay } = setup();
    await relay.onModuleInit();

    await bus.publish(reading());
    expect(gateway.broadcastAlert).not.toHaveBeenCalled();
  });
});
