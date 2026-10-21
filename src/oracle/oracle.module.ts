import { Module } from "@nestjs/common";
import { DbModule } from "../db/db.module";
import { StellarModule } from "../stellar/stellar.module";
import { OracleController } from "./oracle.controller";
import { OracleEventRepository } from "./oracle-event.repository";
import { OracleGateway } from "./oracle.gateway";
import { OraclePublisherService } from "./oracle-publisher.service";
import { OracleScheduler } from "./oracle.scheduler";
import { OracleService } from "./oracle.service";

@Module({
  imports: [DbModule, StellarModule],
  controllers: [OracleController],
  providers: [OracleService, OracleEventRepository, OracleGateway, OracleScheduler, OraclePublisherService],
  exports: [OracleService, OracleEventRepository, OracleGateway, OraclePublisherService],
})
export class OracleModule {}
