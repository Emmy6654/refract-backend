import { Module } from "@nestjs/common";
import { PoolModule } from "../pool/pool.module";
import { OracleTrustModule } from "../oracle/oracle-trust.module";
import { QuoteController } from "./quote.controller";
import { QuoteService } from "./quote.service";

@Module({
  imports: [PoolModule, OracleTrustModule],
  controllers: [QuoteController],
  providers: [QuoteService],
  exports: [QuoteService],
})
export class QuoteModule {}
