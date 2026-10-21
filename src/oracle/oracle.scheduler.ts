import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { OracleGateway } from "./oracle.gateway";
import { OraclePublisherService } from "./oracle-publisher.service";
import { OracleService } from "./oracle.service";

@Injectable()
export class OracleScheduler {
  private readonly logger = new Logger(OracleScheduler.name);

  constructor(
    private readonly oracleService: OracleService,
    private readonly oracleGateway: OracleGateway,
    private readonly oraclePublisher: OraclePublisherService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async pollOracles(): Promise<void> {
    try {
      const readings = await this.oracleService.checkAll();
      for (const reading of readings) {
        await this.oraclePublisher.maybePublish(reading);
        if (reading.severity !== "low") this.oracleGateway.broadcastAlert(reading);
      }
    } catch (error) {
      this.logger.error(
        "Oracle polling failed",
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
