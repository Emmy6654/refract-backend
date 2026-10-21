import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import configuration, { AppConfig } from "./config/configuration";
import { CacheModule } from "./cache/cache.module";
import { ClaimModule } from "./claim/claim.module";
import { DatabaseModule } from "./database/database.module";
import { DbModule } from "./db/db.module";
import { EventsModule } from "./events/events.module";
import { HealthModule } from "./health/health.module";
import { IdempotencyModule } from "./common/idempotency.module";
import { MetricsModule } from "./metrics/metrics.module";
import { OracleModule } from "./oracle/oracle.module";
import { PolicyModule } from "./policy/policy.module";
import { PoolModule } from "./pool/pool.module";
import { QuoteModule } from "./quote/quote.module";
import { StellarModule } from "./stellar/stellar.module";
import { TxModule } from "./tx/tx.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => ({
        throttlers: [
          { name: "upstream", ...config.get("throttle.upstream", { infer: true }) },
          { name: "chain", ...config.get("throttle.chain", { infer: true }) },
          { name: "default", ...config.get("throttle.default", { infer: true }) },
          { name: "catalog", ...config.get("throttle.catalog", { infer: true }) },
        ],
      }),
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    DbModule,
    CacheModule,
    IdempotencyModule,
    StellarModule,
    HealthModule,
    MetricsModule,
    EventsModule,
    QuoteModule,
    PolicyModule,
    PoolModule,
    OracleModule,
    ClaimModule,
    TxModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
