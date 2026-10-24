import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ClaimService, ScanOutcome } from './claim.service';
import { ProtocolParametersService } from '../parameters/protocol-parameters.service';
import { LeaderElector } from '../leader/leader-elector.service';

/**
 * Upper bound (ms) we are willing to wait for an in-flight settlement run to
 * finish before letting the process shut down. Kept in sync with the
 * bootstrap-level shutdown grace period so a stuck settlement cannot block
 * SIGTERM handling indefinitely.
 */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000;

@Injectable()
export class ClaimScheduler implements OnModuleInit, OnApplicationShutdown {
  readonly logger = new Logger(ClaimScheduler.name);

  /**
   * Tracks the currently executing settlement run so shutdown can wait for it
   * to complete instead of interrupting a mid-flight Soroban settlement.
   */
  private inFlight: Promise<void> | null = null;

  /**
   * Set once shutdown has begun so no new settlement runs are started while
   * the current one drains.
   */
  private shuttingDown = false;

  constructor(
    private readonly claimService: ClaimService,
    private readonly protocolParameters: ProtocolParametersService,
    private readonly leaderElector: LeaderElector,
  ) {}

  async onModuleInit(): Promise<void> {
    const interval = await this.getIntervalSeconds();
    this.logger.log(`Claim scheduler initialized with interval ${interval}s`);
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.shuttingDown = true;

    this.logger.log(
      `ClaimScheduler shutdown (${signal ?? 'unknown'}): waiting up to ${SHUTDOWN_DRAIN_TIMEOUT_MS}ms for in-flight settlement run to finish.`,
    );

    const drained = await this.waitForInFlight();

    if (drained) {
      this.logger.log('In-flight settlement run completed cleanly.');
    } else {
      this.logger.warn(
        `In-flight settlement run did not finish within ${SHUTDOWN_DRAIN_TIMEOUT_MS}ms; proceeding with shutdown. The run may be interrupted.`,
      );
    }
  }

  /**
   * Resolve the claim scheduler interval from the protocol-parameters registry,
   * falling back to the default when no override is configured.
   */
  private async getIntervalSeconds(): Promise<number> {
    const value = await this.protocolParameters.getNumber(
      CLAIM_SCHEDULER_INTERVAL_KEY,
      DEFAULT_CLAIM_SCHEDULER_INTERVAL_SECONDS,
    );
    return value > 0 ? value : DEFAULT_CLAIM_SCHEDULER_INTERVAL_SECONDS;
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async handleClaimSettlement(): Promise<void> {
    if (this.shuttingDown) {
      this.logger.log(
        'Skipping claim settlement run: scheduler is shutting down.',
      );
      return;
    }

    if (!this.leaderElector.isLeader()) {
      this.logger.debug('Skipping claim settlement run: this instance is not the leader.');
      return;
    }

    if (this.inFlight) {
      this.logger.warn(
        'Skipping claim settlement run: a previous run is still in flight.',
      );
      return;
    }

    this.logger.debug("Running claim processing");

    const run = this.runSettlement();
    this.inFlight = run;
    try {
      await run;
    } finally {
      if (this.inFlight === run) {
        this.inFlight = null;
      }
    }
  }

  private async runSettlement(): Promise<void> {
    await this.scanAndSettle();
  }

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

  private waitForInFlight(): Promise<boolean> {
    const run = this.inFlight;
    if (!run) {
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), SHUTDOWN_DRAIN_TIMEOUT_MS);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }

      run
        .catch(() => undefined)
        .then(() => {
          clearTimeout(timer);
          resolve(true);
        });
    });
  }
}
