import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import configuration from "./config/configuration";
import { CacheModule } from "./cache/cache.module";
import { ClaimModule } from "./claim/claim.module";
import { DbModule } from "./db/db.module";
import { DatabaseModule } from "./database/database.module";
import { HealthModule } from "./health/health.module";
import { OracleModule } from "./oracle/oracle.module";
import { PolicyModule } from "./policy/policy.module";
import { PoolModule } from "./pool/pool.module";
import { QuoteModule } from "./quote/quote.module";
import { StellarModule } from "./stellar/stellar.module";
import { TxModule } from "./tx/tx.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    ScheduleModule.forRoot(),
    CacheModule,
    DatabaseModule,
    DbModule,
    StellarModule,
    HealthModule,
    QuoteModule,
    PolicyModule,
    PoolModule,
    OracleModule,
    ClaimModule,
    TxModule,
  ],
})
export class AppModule {}
