import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import configuration from "../config/configuration";
import { AlertingModule } from "../alerting/alerting.module";
import { CacheModule } from "../cache/cache.module";
import { ClaimModule } from "../claim/claim.module";
import { DatabaseModule } from "../database/database.module";
import { DbModule } from "../db/db.module";
import { IdempotencyModule } from "../common/idempotency.module";
import { MetricsModule } from "../metrics/metrics.module";
import { OracleModule } from "../oracle/oracle.module";
import { ReadingBusModule } from "../oracle/reading-bus.module";
import { PolicyModule } from "../policy/policy.module";
import { StellarModule } from "../stellar/stellar.module";
import { RuntimeModule } from "../runtime/runtime.module";

/**
 * Root module for the worker tier: oracle polling, consensus evaluation,
 * on-chain publishing and claim settlement.
 *
 * It shares the data layer with the API but leaves out everything that
 * serves requests — controllers are never bound (the worker is started as
 * an application context, not an HTTP app), and the throttler, API-key
 * guard, quote/pool/tx/security-report modules are not imported at all.
 * Readings reach the API through the ReadingBus.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    ScheduleModule.forRoot(),
    RuntimeModule,
    DatabaseModule,
    DbModule,
    IdempotencyModule,
    CacheModule,
    StellarModule,
    MetricsModule,
    AlertingModule,
    ReadingBusModule,
    PolicyModule,
    OracleModule,
    ClaimModule,
  ],
})
export class WorkerModule {}
