import { Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { AlertingService } from "../../alerting/alerting.service";
import { PipelineHeartbeat } from "../../runtime/pipeline-heartbeat";
import { runsPipeline } from "../../runtime/process-role";
import { FeeSpendTracker } from "./fee-spend-tracker";
import { HorizonRelayerClient, RelayerAccountNotFoundError } from "./horizon-relayer.client";
import {
  BalanceAlertTier,
  BalanceAssessment,
  FeeSpendSummary,
  assessBalance,
  decideAlert,
  formatXlm,
} from "./relayer-balance.policy";
import { RelayerMonitorConfig } from "./relayer-monitor.config";

export const RELAYER_MONITOR_STAGE = "relayer-monitor";

/** Where balance and fee metrics go. MetricsService implements this. */
export interface RelayerMetricsSink {
  recordRelayerBalance(assessment: BalanceAssessment, spend: FeeSpendSummary): void;
  recordRelayerFee(feeStroops: bigint, successful: boolean): void;
}

/** Cap on Horizon pages read per check, so a long outage cannot stall a check. */
const MAX_PAGES_PER_CHECK = 10;
const PAGE_SIZE = 200;

export interface RelayerMonitorStatus {
  publicKey: string | null;
  lastCheckedAt: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  assessment: BalanceAssessment | null;
  feeSpend: FeeSpendSummary | null;
}

/**
 * Watches the relayer account that pays every oracle publish and claim
 * settlement fee. Each check reads the balance and any new relayer-paid
 * transactions from Horizon, works out the spendable balance and runway at
 * the current fee spend, and raises tiered alerts (warning → critical →
 * exhausted) before the relayer can no longer submit.
 *
 * Runs in the worker tier only. Built by RelayerMonitorModule's factory.
 */
export class RelayerBalanceMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RelayerBalanceMonitor.name);
  private readonly tracker: FeeSpendTracker;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  private cursor: string | null = null;
  private tier: BalanceAlertTier = "ok";
  private lastAlertAt: number | null = null;
  private unknownAlerted = false;
  private status: RelayerMonitorStatus;

  constructor(
    private readonly config: RelayerMonitorConfig,
    private readonly client: HorizonRelayerClient | null,
    private readonly alerting: AlertingService,
    private readonly metrics?: RelayerMetricsSink,
    private readonly heartbeat?: PipelineHeartbeat,
    private readonly now: () => number = Date.now
  ) {
    this.tracker = new FeeSpendTracker(config.feeWindowMs);
    this.status = {
      publicKey: config.publicKey,
      lastCheckedAt: null,
      consecutiveFailures: 0,
      lastError: null,
      assessment: null,
      feeSpend: null,
    };
  }

  onModuleInit(): void {
    if (!runsPipeline()) return;
    if (!this.config.enabled || !this.client) {
      this.logger.warn(`Relayer balance monitoring is off: ${this.config.disabledReason ?? "not configured"}`);
      return;
    }
    this.heartbeat?.expect(RELAYER_MONITOR_STAGE);
    this.logger.log(
      `Monitoring relayer ${this.config.publicKey} every ${this.config.intervalMs}ms via ${this.config.horizonUrl}`
    );
    void this.check();
    this.timer = setInterval(() => void this.check(), this.config.intervalMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  getStatus(): RelayerMonitorStatus {
    return { ...this.status };
  }

  /** Run one check. Overlapping calls share the in-flight run. */
  check(): Promise<void> {
    if (!this.running) {
      this.running = this.runCheck().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async runCheck(): Promise<void> {
    if (!this.client) return;
    try {
      await this.ingestFeeSpend();
      const snapshot = await this.client.getAccount();
      const now = this.now();
      const spend = this.tracker.summary(now);
      const assessment = assessBalance(snapshot, spend, this.config.thresholds);

      this.metrics?.recordRelayerBalance(assessment, spend);
      this.handleTier(assessment, now);
      if (this.unknownAlerted) {
        this.alerting.emit("info", "Relayer balance monitoring restored", "Horizon is reachable again", {
          publicKey: this.config.publicKey,
        });
        this.unknownAlerted = false;
      }
      this.status = {
        ...this.status,
        lastCheckedAt: now,
        consecutiveFailures: 0,
        lastError: null,
        assessment,
        feeSpend: spend,
      };
      this.heartbeat?.beat(RELAYER_MONITOR_STAGE);
    } catch (err) {
      this.handleFailure(err);
    }
  }

  private async ingestFeeSpend(): Promise<void> {
    for (let page = 0; page < MAX_PAGES_PER_CHECK; page++) {
      const result = await this.client!.listFeeSpend(this.cursor, PAGE_SIZE);
      for (const r of result.records) {
        if (this.tracker.record(r)) this.metrics?.recordRelayerFee(r.feeChargedStroops, r.successful);
      }
      const wasBackfill = this.cursor === null;
      this.cursor = result.cursor;
      // The first (backfill) call reads the newest page only; afterwards keep
      // paging forward until a short page means we are caught up.
      if (wasBackfill || result.records.length < PAGE_SIZE) return;
    }
  }

  private handleTier(a: BalanceAssessment, now: number): void {
    const decision = decideAlert(this.tier, a.tier, this.lastAlertAt, now, this.config.renotifyMs);
    const previous = this.tier;
    this.tier = a.tier;
    if (!decision.emit) return;

    const title =
      decision.kind === "recovered"
        ? `Relayer balance recovered to ${a.tier}`
        : `Relayer balance ${a.tier}${decision.kind === "reminder" ? " (still)" : ""}`;
    const message =
      a.reasons.length > 0
        ? a.reasons.join("; ")
        : `spendable ${formatXlm(a.spendableStroops)} is above all thresholds`;
    this.alerting.emit(decision.severity, title, message, {
      publicKey: this.config.publicKey,
      previousTier: previous,
      tier: a.tier,
      balance: formatXlm(a.balanceStroops),
      reserve: formatXlm(a.reserveStroops),
      spendable: formatXlm(a.spendableStroops),
      nextFee: formatXlm(a.nextFeeStroops),
      runwayHours: a.runwayHours,
      runwaySubmissions: a.runwaySubmissions,
    });
    this.lastAlertAt = decision.kind === "recovered" && a.tier === "ok" ? null : now;
  }

  private handleFailure(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.status = { ...this.status, consecutiveFailures: this.status.consecutiveFailures + 1, lastError: message };
    this.logger.warn(`Relayer balance check failed: ${message}`);

    // A missing account means the relayer cannot submit at all.
    if (err instanceof RelayerAccountNotFoundError) {
      if (this.tier !== "exhausted") {
        this.alerting.emit("critical", "Relayer balance exhausted", message, { publicKey: this.config.publicKey });
        this.tier = "exhausted";
        this.lastAlertAt = this.now();
      }
      return;
    }
    // Not knowing the balance is itself a risk once it persists.
    if (!this.unknownAlerted && this.status.consecutiveFailures >= this.config.failuresBeforeAlert) {
      this.alerting.emit(
        "warning",
        "Relayer balance unknown",
        `${this.status.consecutiveFailures} consecutive balance checks failed: ${message}`,
        { publicKey: this.config.publicKey, horizonUrl: this.config.horizonUrl }
      );
      this.unknownAlerted = true;
    }
  }
}
