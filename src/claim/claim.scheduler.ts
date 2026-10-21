import { Injectable, Logger } from "@nestjs/common";
import { ClaimService, ScanOutcome } from "./claim.service";

@Injectable()
export class ClaimScheduler {
  readonly logger = new Logger(ClaimScheduler.name);

  constructor(private readonly claimService: ClaimService) {}

  async scanAndSettle(): Promise<void> {
    try {
      const outcome: ScanOutcome = await this.claimService.processTriggeredWithStats();
      const { counts } = outcome;
      this.logger.log(
        `claim scan: scanned=${counts.scanned} triggered=${counts.triggered} settled=${counts.settled} deferred=${counts.deferred} transient=${counts.failedTransient} permanent=${counts.failedPermanent} indeterminate=${counts.failedIndeterminate} deadLettered=${counts.deadLettered}`
      );
      if (outcome.settled.length > 0) {
        this.logger.log(`Settled ${outcome.settled.length} claims this cycle`);
      }
    } catch (error) {
      this.logger.error("Claim scan failed", error instanceof Error ? error.stack : String(error));
    }
  }
}
