import { Injectable, Logger, Module, Optional } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { RuntimeModule } from "./runtime.module";
import { resolveProcessRole, runsPipeline, servesApi } from "./process-role";
import { PipelineHeartbeat } from "./pipeline-heartbeat";
import { installGracefulShutdown } from "./graceful-shutdown";

describe("process role", () => {
  it("defaults to 'all' so unsplit deployments keep paying out", () => {
    expect(resolveProcessRole({})).toBe("all");
    expect(resolveProcessRole({ PROCESS_ROLE: "  " })).toBe("all");
  });

  it("accepts api / worker / all case-insensitively", () => {
    expect(resolveProcessRole({ PROCESS_ROLE: "API" })).toBe("api");
    expect(resolveProcessRole({ PROCESS_ROLE: "worker" })).toBe("worker");
    expect(resolveProcessRole({ PROCESS_ROLE: " All " })).toBe("all");
  });

  it("rejects unknown roles instead of guessing", () => {
    expect(() => resolveProcessRole({ PROCESS_ROLE: "both" })).toThrow(/Invalid PROCESS_ROLE/);
  });

  it.each([
    ["api", false, true],
    ["worker", true, false],
    ["all", true, true],
  ])("role %s: runsPipeline=%s servesApi=%s", (role, pipeline, api) => {
    const env = { PROCESS_ROLE: role };
    expect(runsPipeline(env)).toBe(pipeline);
    expect(servesApi(env)).toBe(api);
  });
});

describe("PipelineHeartbeat", () => {
  it("is healthy until an expected stage misses its window", () => {
    let now = 1_000;
    const hb = new PipelineHeartbeat(100, () => now);
    hb.expect("oracle");

    now = 1_100;
    expect(hb.status().healthy).toBe(true);

    now = 1_101;
    expect(hb.status()).toMatchObject({ healthy: false, staleStages: ["oracle"] });

    hb.beat("oracle");
    expect(hb.status()).toMatchObject({ healthy: true, lastBeats: { oracle: 1_101 } });
  });

  it("ignores stages that were never expected", () => {
    let now = 0;
    const hb = new PipelineHeartbeat(10, () => now);
    hb.beat("adhoc");
    now = 1_000;
    expect(hb.status().healthy).toBe(true);
  });
});

describe("RuntimeModule", () => {
  @Injectable()
  class FeatureScheduler {
    constructor(@Optional() readonly heartbeat?: PipelineHeartbeat) {}
  }
  @Module({ providers: [FeatureScheduler] })
  class FeatureModule {}

  it("makes one PipelineHeartbeat visible to schedulers in feature modules", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [RuntimeModule, FeatureModule] }).compile();
    const scheduler = moduleRef.get(FeatureScheduler);
    expect(scheduler.heartbeat).toBeInstanceOf(PipelineHeartbeat);
    expect(scheduler.heartbeat).toBe(moduleRef.get(PipelineHeartbeat));
  });
});

describe("installGracefulShutdown", () => {
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger;
  let before: { term: Function[]; int: Function[] };

  beforeEach(() => {
    before = { term: process.listeners("SIGTERM"), int: process.listeners("SIGINT") };
  });

  afterEach(() => {
    for (const l of process.listeners("SIGTERM")) if (!before.term.includes(l)) process.off("SIGTERM", l as never);
    for (const l of process.listeners("SIGINT")) if (!before.int.includes(l)) process.off("SIGINT", l as never);
  });

  it("closes once and exits 0", async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    const exit = jest.fn();
    const shutdown = installGracefulShutdown(close, logger, 1_000, exit);

    await shutdown("SIGTERM");
    await shutdown("SIGINT");

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exits 1 when close fails", async () => {
    const exit = jest.fn();
    const shutdown = installGracefulShutdown(() => Promise.reject(new Error("boom")), logger, 1_000, exit);
    await shutdown("SIGTERM");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("forces exit 1 when close exceeds the grace period", async () => {
    jest.useFakeTimers();
    try {
      const exit = jest.fn();
      const shutdown = installGracefulShutdown(() => new Promise<void>(() => undefined), logger, 50, exit);
      void shutdown("SIGTERM");
      jest.advanceTimersByTime(51);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
