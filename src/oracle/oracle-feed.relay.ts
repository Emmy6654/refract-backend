import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { OracleGateway } from "./oracle.gateway";
import { OracleReading } from "./oracle-reading";
import { ReadingBus } from "./reading-bus";
import { servesApi } from "../runtime/process-role";

/**
 * API-side half of the worker split: forwards readings the worker publishes
 * on the ReadingBus to WebSocket clients, and answers "latest reading"
 * queries from the shared store. It never polls upstream sources.
 *
 * Only non-"low" readings are pushed over the socket, matching the feed's
 * behaviour before the split.
 */
@Injectable()
export class OracleFeedRelay implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OracleFeedRelay.name);
  private unsubscribe: (() => Promise<void>) | null = null;

  constructor(
    private readonly bus: ReadingBus,
    private readonly gateway: OracleGateway
  ) {}

  async onModuleInit(): Promise<void> {
    if (!servesApi()) {
      return;
    }
    this.unsubscribe = await this.bus.subscribe((reading) => this.relay(reading));
    this.logger.log("Relaying oracle readings from the worker to WebSocket clients");
  }

  async onModuleDestroy(): Promise<void> {
    await this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Latest reading per coverage type, as last published by the worker. */
  latest(): Promise<OracleReading[]> {
    return this.bus.latest();
  }

  private relay(reading: OracleReading): void {
    if (reading.severity === "low") {
      return;
    }
    this.logger.warn(`Oracle alert: ${reading.coverageType} — ${reading.message}`);
    this.gateway.broadcastAlert(reading);
  }
}
