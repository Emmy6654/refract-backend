import { Module } from "@nestjs/common";
import { CacheModule } from "../cache/cache.module";
import { DbModule } from "../db/db.module";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";

@Module({
  imports: [CacheModule, DbModule],
  controllers: [HealthController],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule {}
