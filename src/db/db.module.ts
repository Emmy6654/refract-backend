import { Global, Module } from "@nestjs/common";
import { DATABASE_POOL, DatabaseModule } from "../database/database.module";
import { DatabaseService } from "./database.service";
import { DbService } from "./db.service";

export const PG_POOL = Symbol("PG_POOL");

@Global()
@Module({
  imports: [DatabaseModule],
  providers: [
    DbService,
    DatabaseService,
    {
      provide: PG_POOL,
      useExisting: DATABASE_POOL,
    },
  ],
  exports: [DbService, DatabaseService, PG_POOL],
})
export class DbModule {}
