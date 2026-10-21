import { DbService } from "../db/db.service";
import { ORACLE_FEEDS } from "../config/oracle-feed.config";
import { OracleTrustService } from "../oracle/oracle-trust.service";
import { SorobanRpcService } from "../stellar/soroban-rpc.service";
import { HealthService } from "./health.service";

describe("HealthService readiness", () => {
  const originalTrustMode = process.env.ORACLE_TRUST_MODE;

  afterEach(() => {
    if (originalTrustMode === undefined) delete process.env.ORACLE_TRUST_MODE;
    else process.env.ORACLE_TRUST_MODE = originalTrustMode;
  });

  it("requires reachable trusted feeds, a satisfiable quorum, healthy RPC, and writable evidence storage", async () => {
    process.env.ORACLE_TRUST_MODE = "development";
    const trust = new OracleTrustService();
    for (const [feedId, config] of Object.entries(ORACLE_FEEDS)) {
      if (config.sourceType === "http") trust.recordObservation(feedId, true);
    }
    trust.setPublisherConfigured(true);

    const rpc = {
      server: { getHealth: jest.fn().mockResolvedValue({ status: "healthy" }) },
    } as unknown as SorobanRpcService;
    const db = {
      isAvailable: jest.fn().mockReturnValue(true),
      withClient: jest.fn(async (fn: (client: { query: jest.Mock }) => Promise<unknown>) =>
        fn({ query: jest.fn().mockResolvedValue({}) }),
      ),
    } as unknown as DbService;
    const service = new HealthService(trust, rpc, db);

    await expect(service.getReadiness()).resolves.toMatchObject({
      ready: true,
      checks: {
        sourcesReachable: true,
        quorumSatisfiable: true,
        rpcHealthy: true,
        evidenceStoreWritable: true,
        publisherConfigured: true,
      },
    });

    (db.withClient as jest.Mock).mockRejectedValueOnce(new Error("read-only database"));
    await expect(service.getReadiness()).resolves.toMatchObject({
      ready: false,
      checks: { evidenceStoreWritable: false },
    });
  });

  it("is not ready when no fresh feed observations can satisfy trust", async () => {
    const rpc = {
      server: { getHealth: jest.fn().mockRejectedValue(new Error("RPC down")) },
    } as unknown as SorobanRpcService;
    const db = {
      isAvailable: jest.fn().mockReturnValue(false),
    } as unknown as DbService;
    const service = new HealthService(new OracleTrustService(), rpc, db);

    await expect(service.getReadiness()).resolves.toMatchObject({
      ready: false,
      status: "not_ready",
      checks: {
        sourcesReachable: false,
        quorumSatisfiable: false,
        rpcHealthy: false,
        evidenceStoreWritable: false,
        publisherConfigured: false,
      },
    });
  });
});
