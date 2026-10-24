import { Global, Module } from "@nestjs/common";
import { OracleTrustService } from "./oracle-trust.service";

@Global()
@Module({
  providers: [OracleTrustService],
  exports: [OracleTrustService],
})
export class OracleTrustModule {}
