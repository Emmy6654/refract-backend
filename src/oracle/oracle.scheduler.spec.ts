import { OracleScheduler } from "./oracle.scheduler";
import { OracleService } from "./oracle.service";
import { OracleGateway } from "./oracle.gateway";
import { OracleReading } from "./oracle-reading";
import { HealthService } from "../health/health.service";

function buildReading(overrides: Partial<OracleReading> = {}): OracleReading {
  return {
    coverageType: "StablecoinDepeg",
    type: "oracle_update",
    value: 1.0,
    threshold: 0.95,
    severity: "low",
    message: "USDC price: $1.0000",
    ...overrides,
  };
}

function buildServices() {
  const oracleService = { checkAllFresh: jest.fn(), checkAll: jest.fn() } as unknown as jest.Mocked<OracleService>;
  const oracleGateway = { broadcastAlert: jest.fn() } as unknown as jest.Mocked<OracleGateway>;
  const oraclePublisher = { maybePublish: jest.fn().mockResolvedValue(null) } as unknown as jest.Mocked<
    import("./oracle-publisher.service").OraclePublisherService
  >;
  return { oracleService, oracleGateway, oraclePublisher };
}

describe("OracleScheduler", () => {
  describe("pollOracles", () => {
    it("broadcasts readings above 'low' severity and skips low ones", async () => {
      const { oracleService, oracleGateway, oraclePublisher } = buildServices();
      const low = buildReading({ coverageType: "StablecoinDepeg", severity: "low" });
      const high = buildReading({ coverageType: "MarketCrash", severity: "high" });
      const triggered = buildReading({ coverageType: "SmartContractRisk", severity: "triggered" });
      oracleService.checkAllFresh.mockResolvedValue([low, high, triggered]);
      oracleService.checkAll.mockResolvedValue([low, high, triggered]);
      const scheduler = new OracleScheduler(oracleService, oracleGateway, oraclePublisher);

      await scheduler.pollOracles();

      expect(oracleGateway.broadcastAlert).toHaveBeenCalledTimes(2);
      expect(oracleGateway.broadcastAlert).toHaveBeenCalledWith(high);
      expect(oracleGateway.broadcastAlert).toHaveBeenCalledWith(triggered);
      expect(oracleGateway.broadcastAlert).not.toHaveBeenCalledWith(low);
      expect(oraclePublisher.maybePublish).toHaveBeenCalledTimes(3);
    });

    it("does not broadcast anything when every reading is 'low' severity", async () => {
      const { oracleService, oracleGateway, oraclePublisher } = buildServices();
      oracleService.checkAllFresh.mockResolvedValue([buildReading({ severity: "low" })]);
      oracleService.checkAll.mockResolvedValue([buildReading({ severity: "low" })]);
      const scheduler = new OracleScheduler(oracleService, oracleGateway, oraclePublisher);

      await scheduler.pollOracles();

      expect(oracleGateway.broadcastAlert).not.toHaveBeenCalled();
      expect(oraclePublisher.maybePublish).toHaveBeenCalledTimes(1);
    });

    it("catches and logs an error from checkAll() instead of throwing", async () => {
      const { oracleService, oracleGateway, oraclePublisher } = buildServices();
      oracleService.checkAllFresh.mockRejectedValue(new Error("all sources down"));
      oracleService.checkAll.mockRejectedValue(new Error("all sources down"));
      const scheduler = new OracleScheduler(oracleService, oracleGateway, oraclePublisher);

      await expect(scheduler.pollOracles()).resolves.toBeUndefined();
      expect(oracleGateway.broadcastAlert).not.toHaveBeenCalled();
      expect(oraclePublisher.maybePublish).not.toHaveBeenCalled();
    });

    it("aborts an expired consensus result without publishing or broadcasting it", async () => {
      const { oracleService, oracleGateway, oraclePublisher } = buildServices();
      oracleService.checkAllFresh.mockResolvedValue([
        buildReading({
          severity: "triggered",
          feedId: "coingecko-usdc",
          observedAt: Date.now() - 2_000,
          deadlineAt: Date.now() - 1,
        }),
      ]);
      const scheduler = new OracleScheduler(oracleService, oracleGateway, oraclePublisher);

      await scheduler.pollOracles();

      expect(oraclePublisher.maybePublish).not.toHaveBeenCalled();
      expect(oracleGateway.broadcastAlert).not.toHaveBeenCalled();
    });

    it("does not publish while RPC or evidence storage is not ready", async () => {
      const { oracleService, oracleGateway, oraclePublisher } = buildServices();
      oracleService.checkAllFresh.mockResolvedValue([buildReading()]);
      const health = {
        getInfrastructureReadiness: jest.fn().mockResolvedValue({
          ready: false,
          checks: { rpcHealthy: false, evidenceStoreWritable: true, publisherConfigured: true },
        }),
      } as unknown as HealthService;
      const scheduler = new OracleScheduler(
        oracleService,
        oracleGateway,
        oraclePublisher,
        undefined,
        health,
      );

      await scheduler.pollOracles();

      expect(oraclePublisher.maybePublish).not.toHaveBeenCalled();
      expect(oracleGateway.broadcastAlert).not.toHaveBeenCalled();
    });
  });
});
