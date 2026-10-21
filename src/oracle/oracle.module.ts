import { Module } from "@nestjs/common";
import { OracleController } from "./oracle.controller";
import { OracleAttestationController } from "./oracle-attestation.controller";
import { OracleAttestationService } from "./oracle-attestation.service";
import { OracleGateway } from "./oracle.gateway";
import { OraclePublisherService } from "./oracle-publisher.service";
import { OracleScheduler } from "./oracle.scheduler";
import { OracleService } from "./oracle.service";

@Module({
  controllers: [OracleController, OracleAttestationController],
  providers: [OracleService, OracleGateway, OracleScheduler, OraclePublisherService, OracleAttestationService],
  exports: [OracleService, OracleGateway, OraclePublisherService],
})
export class OracleModule {}
