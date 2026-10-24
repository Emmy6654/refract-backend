import fc from "fast-check";
import { Keypair } from "@stellar/stellar-sdk";
import { AlertingService } from "../../alerting/alerting.service";
import { PipelineHeartbeat } from "../../runtime/pipeline-heartbeat";
import { FeeSpendTracker } from "./fee-spend-tracker";
import { HorizonRelayerClient, RelayerAccountNotFoundError } from "./horizon-relayer.client";
import {
  BalanceThresholds,
  FeeSpendSummary,
  RelayerAccountSnapshot,
  assessBalance,
  decideAlert,
  formatXlm,
  minimumReserveStroops,
  parseXlmToStroops,
  spendableStroops,
  tierRank,
} from "./relayer-balance.policy";
import { RelayerBalanceMonitor, RelayerMetricsSink } from "./relayer-balance-monitor.service";
import { RelayerMonitorConfig, loadRelayerMonitorConfig } from "./relayer-monitor.config";

const XLM = 10_000_000n;
const HOUR = 3_600_000;

const thresholds: BalanceThresholds = {
  warningStroops: 100n * XLM,
  criticalStroops: 25n * XLM,
  warningRunwayHours: 72,
  criticalRunwayHours: 24,
  warningRunwaySubmissions: 1_000,
  criticalRunwaySubmissions: 200,
  minSubmissionFeeStroops: XLM / 100n,
};

function account(balanceXlm: string, overrides: Partial<RelayerAccountSnapshot> = {}): RelayerAccountSnapshot {
  return {
    balanceStroops: parseXlmToStroops(balanceXlm),
    sellingLiabilitiesStroops: 0n,
    subentryCount: 0,
    numSponsoring: 0,
    numSponsored: 0,
    ...overrides,
  };
}

const NO_SPEND: FeeSpendSummary = { count: 0, totalStroops: 0n, avgStroops: 0, maxStroops: 0n, ratePerHourStroops: 0 };

describe("XLM amounts", () => {
  it("parses Horizon balances exactly, without float rounding", () => {
    expect(parseXlmToStroops("123.4567890")).toBe(1_234_567_890n);
    expect(parseXlmToStroops("0.0000001")).toBe(1n);
    expect(parseXlmToStroops("100")).toBe(1_000_000_000n);
    expect(() => parseXlmToStroops("1.12345678")).toThrow();
    expect(() => parseXlmToStroops("1e3")).toThrow();
  });

  it("round-trips through formatXlm", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 17n }), (stroops) => {
        return parseXlmToStroops(formatXlm(stroops).replace(" XLM", "")) === stroops;
      })
    );
  });
});

describe("reserve and spendable balance", () => {
  it("applies the (2 + entries) × 0.5 XLM minimum reserve", () => {
    expect(minimumReserveStroops(account("10"))).toBe(1n * XLM);
    expect(minimumReserveStroops(account("10", { subentryCount: 3, numSponsoring: 1, numSponsored: 2 }))).toBe(2n * XLM);
  });

  it("subtracts reserve and selling liabilities and never goes negative", () => {
    expect(spendableStroops(account("10", { sellingLiabilitiesStroops: 2n * XLM }))).toBe(7n * XLM);
    expect(spendableStroops(account("0.5"))).toBe(0n);
  });
});

describe("assessBalance", () => {
  it("is ok with a healthy balance and no history", () => {
    const a = assessBalance(account("1000"), NO_SPEND, thresholds);
    expect(a.tier).toBe("ok");
    expect(a.runwayHours).toBeNull();
    expect(a.reasons).toEqual([]);
  });

  it.each([
    ["warning", "90"],
    ["critical", "20"],
    ["exhausted", "1.005"],
  ])("goes %s on absolute balance (balance %s XLM)", (tier, balance) => {
    expect(assessBalance(account(balance), NO_SPEND, thresholds).tier).toBe(tier);
  });

  it("warns on time runway even when the balance looks large", () => {
    // 1000 XLM spendable-ish, burning 20 XLM/h → ~50h left
    const spend: FeeSpendSummary = { count: 10, totalStroops: 0n, avgStroops: 100, maxStroops: 100n, ratePerHourStroops: 20 * Number(XLM) };
    const a = assessBalance(account("1001"), spend, thresholds);
    expect(a.tier).toBe("warning");
    expect(a.runwayHours).toBeCloseTo(50, 5);
    expect(a.reasons[0]).toMatch(/50\.0h of fees left/);
  });

  it("goes critical on submission runway when per-publish fees are high", () => {
    // 500 XLM spendable at 5 XLM per publish → 100 submissions left
    const spend: FeeSpendSummary = { count: 3, totalStroops: 15n * XLM, avgStroops: 5 * Number(XLM), maxStroops: 5n * XLM, ratePerHourStroops: 1 };
    const a = assessBalance(account("501"), spend, thresholds);
    expect(a.tier).toBe("critical");
    expect(a.runwaySubmissions).toBeCloseTo(100, 5);
  });

  it("is exhausted when the next fee, sized from the largest recent fee, cannot be covered", () => {
    const spend: FeeSpendSummary = { count: 1, totalStroops: 3n * XLM, avgStroops: 3 * Number(XLM), maxStroops: 3n * XLM, ratePerHourStroops: 0 };
    const a = assessBalance(account("3.5"), spend, thresholds);
    expect(a.nextFeeStroops).toBe(3n * XLM);
    expect(a.tier).toBe("exhausted");
  });

  it("never reports a better tier for a lower balance (property)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000n * XLM }),
        fc.bigInt({ min: 0n, max: 10_000n * XLM }),
        fc.record({
          count: fc.integer({ min: 0, max: 1_000 }),
          avg: fc.integer({ min: 0, max: 10_000_000 }),
          max: fc.bigInt({ min: 0n, max: 100_000_000n }),
          rate: fc.integer({ min: 0, max: 1_000_000_000 }),
        }),
        (b1, b2, s) => {
          const spend: FeeSpendSummary = {
            count: s.count,
            totalStroops: 0n,
            avgStroops: s.avg,
            maxStroops: s.max,
            ratePerHourStroops: s.rate,
          };
          const [lo, hi] = b1 <= b2 ? [b1, b2] : [b2, b1];
          const tLo = assessBalance({ ...account("0"), balanceStroops: lo }, spend, thresholds).tier;
          const tHi = assessBalance({ ...account("0"), balanceStroops: hi }, spend, thresholds).tier;
          return tierRank(tLo) >= tierRank(tHi);
        }
      )
    );
  });
});

describe("decideAlert", () => {
  const RENOTIFY = HOUR;

  it("alerts on every escalation with matching severity", () => {
    expect(decideAlert("ok", "warning", null, 0, RENOTIFY)).toEqual({ emit: true, kind: "escalated", severity: "warning" });
    expect(decideAlert("warning", "critical", 0, 1, RENOTIFY)).toEqual({ emit: true, kind: "escalated", severity: "critical" });
    expect(decideAlert("ok", "exhausted", null, 0, RENOTIFY)).toMatchObject({ severity: "critical" });
  });

  it("announces recovery once", () => {
    expect(decideAlert("critical", "ok", 0, 1, RENOTIFY)).toEqual({ emit: true, kind: "recovered", severity: "info" });
    expect(decideAlert("critical", "warning", 0, 1, RENOTIFY)).toEqual({ emit: true, kind: "recovered", severity: "warning" });
    expect(decideAlert("ok", "ok", null, 1, RENOTIFY)).toEqual({ emit: false });
  });

  it("reminds while a problem persists, but not more often than the renotify interval", () => {
    expect(decideAlert("critical", "critical", 0, RENOTIFY - 1, RENOTIFY)).toEqual({ emit: false });
    expect(decideAlert("critical", "critical", 0, RENOTIFY, RENOTIFY)).toEqual({ emit: true, kind: "reminder", severity: "critical" });
  });
});

describe("FeeSpendTracker", () => {
  it("dedupes by hash, counts failed transactions, and prunes outside the window", () => {
    const t = new FeeSpendTracker(24 * HOUR, 0);
    expect(t.record({ txHash: "a", feeChargedStroops: 100n, at: 0, successful: true })).toBe(true);
    expect(t.record({ txHash: "a", feeChargedStroops: 100n, at: 0, successful: true })).toBe(false);
    t.record({ txHash: "b", feeChargedStroops: 300n, at: HOUR, successful: false });

    expect(t.summary(2 * HOUR)).toEqual({ count: 2, totalStroops: 400n, avgStroops: 200, maxStroops: 300n, ratePerHourStroops: 200 });
    expect(t.summary(24 * HOUR + 1).count).toBe(1);
  });

  it("does not extrapolate a startup burst into a huge hourly rate", () => {
    const t = new FeeSpendTracker(24 * HOUR, 15 * 60_000);
    t.record({ txHash: "a", feeChargedStroops: 1_000n, at: 0, successful: true });
    expect(t.summary(1_000).ratePerHourStroops).toBe(4_000); // 1000 per 15 min, not per second
  });
});

// ------------------------------------------------------------------ Horizon client

const RELAYER = Keypair.random().publicKey();
const BUMPER = Keypair.random().publicKey();

function horizonTx(n: number, overrides: Record<string, unknown> = {}) {
  return {
    hash: `h${n}`,
    paging_token: `pt${n}`,
    fee_charged: "1000",
    source_account: RELAYER,
    fee_account: RELAYER,
    successful: true,
    created_at: new Date(1_800_000_000_000 + n * 60_000).toISOString(),
    ...overrides,
  };
}

function fakeHorizon(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: string[] = [];
  const fetchFn = jest.fn(async (url: string) => {
    calls.push(url);
    const path = url.replace("https://horizon.test", "");
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    const route = key ? routes[key] : { status: 404 };
    return { ok: (route.status ?? 200) < 400, status: route.status ?? 200, json: async () => route.body };
  });
  return { fetchFn, calls };
}

describe("HorizonRelayerClient", () => {
  it("reads balance, liabilities and reserve inputs", async () => {
    const { fetchFn } = fakeHorizon({
      [`/accounts/${RELAYER}`]: {
        body: {
          balances: [
            { asset_type: "credit_alphanum4", balance: "5.0000000" },
            { asset_type: "native", balance: "42.1234567", selling_liabilities: "1.0000000" },
          ],
          subentry_count: 2,
          num_sponsoring: 1,
        },
      },
    });
    const client = new HorizonRelayerClient("https://horizon.test/", RELAYER, 1_000, fetchFn);
    await expect(client.getAccount()).resolves.toEqual({
      balanceStroops: 421_234_567n,
      sellingLiabilitiesStroops: 10_000_000n,
      subentryCount: 2,
      numSponsoring: 1,
      numSponsored: 0,
    });
  });

  it("reports an unfunded account distinctly", async () => {
    const { fetchFn } = fakeHorizon({});
    await expect(new HorizonRelayerClient("https://horizon.test", RELAYER, 1_000, fetchFn).getAccount()).rejects.toBeInstanceOf(
      RelayerAccountNotFoundError
    );
  });

  it("backfills newest-first, returns oldest-first, and only counts fees the relayer paid", async () => {
    const { fetchFn, calls } = fakeHorizon({
      [`/accounts/${RELAYER}/transactions`]: {
        body: { _embedded: { records: [horizonTx(3), horizonTx(2, { fee_account: BUMPER }), horizonTx(1, { successful: false })] } },
      },
    });
    const page = await new HorizonRelayerClient("https://horizon.test", RELAYER, 1_000, fetchFn).listFeeSpend(null);

    expect(calls[0]).toContain("order=desc");
    expect(calls[0]).toContain("include_failed=true");
    expect(page.records.map((r) => [r.txHash, r.successful])).toEqual([
      ["h1", false],
      ["h3", true],
    ]);
    expect(page.cursor).toBe("pt3");
  });
});

// ------------------------------------------------------------------ config

describe("loadRelayerMonitorConfig", () => {
  it("prefers RELAYER_PUBLIC_KEY and picks Horizon from the network", () => {
    const cfg = loadRelayerMonitorConfig({ RELAYER_PUBLIC_KEY: RELAYER, STELLAR_NETWORK: "mainnet" });
    expect(cfg).toMatchObject({ enabled: true, publicKey: RELAYER, horizonUrl: "https://horizon.stellar.org" });
    expect(cfg.thresholds.warningStroops).toBe(100n * XLM);
  });

  it("derives the public key from the relayer secret when needed", () => {
    const kp = Keypair.random();
    expect(loadRelayerMonitorConfig({ ORACLE_RELAYER_SECRET: kp.secret() }).publicKey).toBe(kp.publicKey());
  });

  it("is disabled, with a reason, when no key is configured or it is opted out", () => {
    expect(loadRelayerMonitorConfig({})).toMatchObject({ enabled: false, disabledReason: expect.stringMatching(/no relayer key/) });
    expect(loadRelayerMonitorConfig({ RELAYER_PUBLIC_KEY: RELAYER, RELAYER_MONITOR_ENABLED: "false" }).enabled).toBe(false);
  });

  it.each([
    [{ RELAYER_BALANCE_WARNING_XLM: "10", RELAYER_BALANCE_CRITICAL_XLM: "20" }, /critical threshold/],
    [{ RELAYER_MONITOR_INTERVAL_MS: "10" }, /RELAYER_MONITOR_INTERVAL_MS/],
    [{ RELAYER_BALANCE_WARNING_XLM: "lots" }, /Invalid XLM amount/],
    [{ RELAYER_PUBLIC_KEY: "GNOPE" }, /RELAYER_PUBLIC_KEY/],
  ])("rejects bad config %#", (env, message) => {
    expect(() => loadRelayerMonitorConfig({ RELAYER_PUBLIC_KEY: RELAYER, ...env })).toThrow(message);
  });
});

// ------------------------------------------------------------------ monitor

describe("RelayerBalanceMonitor", () => {
  const originalRole = process.env.PROCESS_ROLE;
  afterEach(() => {
    if (originalRole === undefined) delete process.env.PROCESS_ROLE;
    else process.env.PROCESS_ROLE = originalRole;
  });

  const config: RelayerMonitorConfig = {
    enabled: true,
    publicKey: RELAYER,
    horizonUrl: "https://horizon.test",
    intervalMs: 60_000,
    feeWindowMs: 24 * HOUR,
    renotifyMs: HOUR,
    failuresBeforeAlert: 2,
    thresholds,
  };

  function setup() {
    let now = 1_800_000_000_000;
    let balance = "1000";
    let txs: Array<ReturnType<typeof horizonTx>> = [];
    let failWith: Error | null = null;
    const client = {
      getAccount: jest.fn(async () => {
        if (failWith) throw failWith;
        return account(balance);
      }),
      listFeeSpend: jest.fn(async (cursor: string | null) => {
        if (failWith) throw failWith;
        const after = cursor ? txs.filter((t) => t.paging_token > cursor) : txs;
        return {
          records: after.map((t) => ({ txHash: t.hash, feeChargedStroops: BigInt(t.fee_charged), at: Date.parse(t.created_at), successful: t.successful })),
          cursor: after.length ? after[after.length - 1].paging_token : cursor,
        };
      }),
    } as unknown as HorizonRelayerClient;
    const alerting = new AlertingService();
    const metrics: RelayerMetricsSink = { recordRelayerBalance: jest.fn(), recordRelayerFee: jest.fn() };
    const heartbeat = new PipelineHeartbeat(HOUR, () => now);
    const monitor = new RelayerBalanceMonitor(config, client, alerting, metrics, heartbeat, () => now);
    return {
      monitor,
      alerting,
      metrics,
      heartbeat,
      client,
      setBalance: (b: string) => (balance = b),
      addTx: (tx: ReturnType<typeof horizonTx>) => (txs = [...txs, tx]),
      fail: (e: Error | null) => (failWith = e),
      advance: (ms: number) => (now += ms),
      titles: () => alerting.listRecent().map((a) => `${a.severity}:${a.title}`).reverse(),
    };
  }

  it("raises tiered alerts as the balance drains, reminds, then reports recovery", async () => {
    const t = setup();
    await t.monitor.check();
    expect(t.titles()).toEqual([]);

    t.setBalance("90");
    await t.monitor.check();
    t.setBalance("20");
    await t.monitor.check();
    t.advance(HOUR);
    await t.monitor.check();
    t.setBalance("500");
    await t.monitor.check();

    expect(t.titles()).toEqual([
      "warning:Relayer balance warning",
      "critical:Relayer balance critical",
      "critical:Relayer balance critical (still)",
      "info:Relayer balance recovered to ok",
    ]);
    expect(t.monitor.getStatus().assessment?.tier).toBe("ok");
  });

  it("tracks per-transaction fee spend, counting each transaction once", async () => {
    const t = setup();
    t.addTx(horizonTx(1, { fee_charged: "50000" }));
    await t.monitor.check();
    t.addTx(horizonTx(2, { fee_charged: "70000", successful: false }));
    await t.monitor.check();
    await t.monitor.check();

    expect(t.metrics.recordRelayerFee).toHaveBeenCalledTimes(2);
    expect(t.metrics.recordRelayerFee).toHaveBeenLastCalledWith(70_000n, false);
    expect(t.monitor.getStatus().feeSpend).toMatchObject({ count: 2, totalStroops: 120_000n, maxStroops: 70_000n });
    expect(t.metrics.recordRelayerBalance).toHaveBeenCalledTimes(3);
  });

  it("alerts when the balance has been unknown for several checks, and when it is back", async () => {
    const t = setup();
    t.fail(new Error("Horizon down"));
    await t.monitor.check();
    expect(t.titles()).toEqual([]);
    await t.monitor.check();
    await t.monitor.check();
    t.fail(null);
    await t.monitor.check();

    expect(t.titles()).toEqual(["warning:Relayer balance unknown", "info:Relayer balance monitoring restored"]);
    expect(t.monitor.getStatus().consecutiveFailures).toBe(0);
  });

  it("treats a missing account as exhausted immediately", async () => {
    const t = setup();
    t.fail(new RelayerAccountNotFoundError(RELAYER));
    await t.monitor.check();
    await t.monitor.check();
    expect(t.titles()).toEqual(["critical:Relayer balance exhausted"]);
  });

  it("beats the pipeline heartbeat only on successful checks", async () => {
    const t = setup();
    t.fail(new Error("down"));
    await t.monitor.check();
    expect(t.heartbeat.status().lastBeats).toEqual({});
    t.fail(null);
    await t.monitor.check();
    expect(Object.keys(t.heartbeat.status().lastBeats)).toEqual(["relayer-monitor"]);
  });

  it("does not start in an API-only process or without a key", async () => {
    process.env.PROCESS_ROLE = "api";
    const t = setup();
    t.monitor.onModuleInit();
    expect(t.client.getAccount).not.toHaveBeenCalled();

    process.env.PROCESS_ROLE = "worker";
    const off = new RelayerBalanceMonitor({ ...config, enabled: false, disabledReason: "test" }, null, new AlertingService());
    off.onModuleInit();
    await off.onModuleDestroy();
  });

  it("starts polling in the worker and stops cleanly", async () => {
    process.env.PROCESS_ROLE = "worker";
    const t = setup();
    t.monitor.onModuleInit();
    await t.monitor.onModuleDestroy();
    expect(t.client.getAccount).toHaveBeenCalledTimes(1);
  });
});
