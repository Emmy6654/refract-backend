import { Module } from "@nestjs/common";
import { OracleFeedRelay } from "./oracle-feed.relay";
import { OracleGateway } from "./oracle.gateway";

/**
 * Read side of the oracle: the WebSocket gateway and the relay that feeds it
 * from the ReadingBus. Imported by the API (AppModule) only — the worker
 * has no HTTP server to attach a gateway to.
 */
@Module({
  providers: [OracleGateway, OracleFeedRelay],
  exports: [OracleGateway, OracleFeedRelay],
})
export class OracleFeedModule {}
