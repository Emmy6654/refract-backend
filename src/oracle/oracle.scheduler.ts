import { Injectable, Logger, Optional } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { MetricsService } from "../metrics/metrics.service";
import { HealthService } from "../health/health.service";
import { OracleGateway } from "./oracle.gateway";
import { OraclePublisherService } from "./oracle-publisher.service";
import { OracleReading } from "./oracle-reading";
import { OracleService } from "./oracle.service";

const DEFAULT_POLL_INTERVAL_MS = 60_000;

function pollIntervalMs(): number {
  const value = Number(process.env.ORACLE_SCHEDULER_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS);
  if (!Number.isInteger(value) || value < 1_000 || value > 3_600_000) {
    throw new Error("ORACLE_SCHEDULER_INTERVAL_MS must be an integer between 1000 and 3600000");
  }
  return value;
}

@Injectable()
export class OracleScheduler {
  private readonly logger = new Logger(OracleScheduler.name);
  private polling = false;

  constructor(
    private readonly oracleService: OracleService,
    private readonly oracleGateway: OracleGateway,
    private readonly oraclePublisher: OraclePublisherService,
    @Optional() private readonly metricsService?: MetricsService,
    @Optional() private readonly healthService?: HealthService,
  ) {}

  @Interval(pollIntervalMs())
  async pollOracles(): Promise<void> {
    if (this.polling) {
      this.logger.warn("Skipping oracle poll because the previous round is still running");
      return;
    }
    this.polling = true;
    const startedAt = Date.now();
    let outcome: "success" | "failure" = "success";

    try {
      const readings = await this.oracleService.checkAllFresh();
      const infrastructure = await this.healthService?.getInfrastructureReadiness();
      if (infrastructure && !infrastructure.ready) {
        this.logger.warn("Skipping oracle publications while required infrastructure is not ready");
        return;
      }
      await Promise.all(readings.map((reading) => this.processReading(reading)));
    } catch (error) {
      outcome = "failure";
      this.logger.error("Oracle refresh failed", error instanceof Error ? error.stack : String(error));
    } finally {
      this.polling = false;
      this.metricsService?.recordSchedulerRun(
        "oracle",
        outcome,
        (Date.now() - startedAt) / 1000,
      );
    }
  }

  private async processReading(reading: OracleReading): Promise<void> {
    const feed = reading.feedId ?? reading.coverageType;
    const observedAt = reading.observedAt ?? Date.now();
    const deadlineAt = reading.deadlineAt ?? observedAt + 30_000;
    if (reading.degraded) {
      this.logger.warn(`Skipping degraded ${feed} reading`);
      return;
    }
    if (reading.fetchDurationMs !== undefined) {
      this.metricsService?.recordOracleStage(feed, "source", reading.fetchDurationMs / 1000);
    }

    const consensusDuration = (Date.now() - observedAt) / 1000;
    this.metricsService?.recordOracleStage(feed, "consensus", consensusDuration);
    if (Date.now() >= deadlineAt) {
      this.metricsService?.recordOracleDeadlineBreach(
        feed,
        "consensus",
        (Date.now() - deadlineAt) / 1000,
      );
      this.logger.warn(`Aborting stale ${feed} reading before publication`);
      return;
    }

    await this.oraclePublisher.maybePublish(reading, deadlineAt);
    if (Date.now() >= deadlineAt) {
      return;
    }

    if (reading.severity !== "low") {
      this.oracleGateway.broadcastAlert(reading);
    }
  }
}
