import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Optional } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { OracleService } from './oracle.service';
import { OracleGateway } from './oracle.gateway';
import { OraclePublisherService } from './oracle-publisher.service';
import { ProtocolParametersService } from '../parameters/protocol-parameters.service';
import { ProtocolParameterKey } from '../parameters/protocol-parameter-key.enum';
import { ReadingBus } from './reading-bus';
import { OracleReading } from './oracle-reading';
import { runsPipeline } from '../runtime/process-role';
import { PipelineHeartbeat } from '../runtime/pipeline-heartbeat';

const ORACLE_REFRESH_JOB_NAME = 'oracle-refresh';
export const ORACLE_PIPELINE_STAGE = 'oracle';

@Injectable()
export class OracleScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OracleScheduler.name);

  constructor(
    private readonly oracleService: OracleService,
    private readonly oracleGateway: OracleGateway,
    private readonly oraclePublisher: OraclePublisherService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly protocolParameters: ProtocolParametersService,
    private readonly readingBus: ReadingBus,
    @Optional() private readonly heartbeat?: PipelineHeartbeat,
  ) {}

  async onModuleInit(): Promise<void> {
    // Polling and consensus belong to the worker tier. The API only relays
    // what the worker publishes (see OracleFeedRelay).
    if (!runsPipeline()) {
      this.logger.log('Oracle polling disabled in this process (PROCESS_ROLE=api)');
      return;
    }
    this.heartbeat?.expect(ORACLE_PIPELINE_STAGE);

    const intervalSeconds = await this.protocolParameters.getNumber(
      ProtocolParameterKey.ORACLE_SCHEDULER_INTERVAL_SECONDS,
    );

    const job = new CronJob(`*/${intervalSeconds} * * * * *`, () => {
      void this.refresh();
    });

    this.schedulerRegistry.addCronJob(ORACLE_REFRESH_JOB_NAME, job);
    job.start();

    this.logger.log(
      `Oracle refresh scheduler started with ${intervalSeconds}s interval`,
    );
  }

  onModuleDestroy(): void {
    if (this.schedulerRegistry.doesExist('cron', ORACLE_REFRESH_JOB_NAME)) {
      this.schedulerRegistry.deleteCronJob(ORACLE_REFRESH_JOB_NAME);
    }
  }

  private async refresh(): Promise<void> {
    try {
      const result: unknown = await this.oracleService.refreshPrices();
      const readings = Array.isArray(result) ? (result as OracleReading[]) : [];
      for (const reading of readings) {
        await this.oraclePublisher.maybePublish(reading);
        if (reading.severity !== 'low') this.oracleGateway.broadcastAlert(reading);
      }
      // Hand readings to the API tier for the WebSocket feed and reads.
      await this.readingBus.publishAll(readings);
      this.heartbeat?.beat(ORACLE_PIPELINE_STAGE);
    } catch (error) {
      this.logger.error('Oracle refresh failed', error as Error);
    }
  }
}
