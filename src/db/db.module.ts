import { Global, Inject, Injectable, Module, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Pool } from "pg";
import { AppConfig } from "../config/configuration";
import { DbService } from "./db.service";

export const PG_POOL = Symbol("PG_POOL");

@Injectable()
class PgPoolShutdown implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    DbService,
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) =>
        new Pool({ connectionString: config.get("database.url", { infer: true }) }),
    },
    PgPoolShutdown,
  ],
  exports: [DbService, PG_POOL],
})
export class DbModule {}
