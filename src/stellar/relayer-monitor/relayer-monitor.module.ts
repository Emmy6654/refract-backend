import { Module } from "@nestjs/common";
import { AlertingModule } from "../../alerting/alerting.module";
import { AlertingService } from "../../alerting/alerting.service";
import { MetricsService } from "../../metrics/metrics.service";
import { PipelineHeartbeat } from "../../runtime/pipeline-heartbeat";
import { HorizonRelayerClient } from "./horizon-relayer.client";
import { RelayerBalanceMonitor } from "./relayer-balance-monitor.service";
import { loadRelayerMonitorConfig } from "./relayer-monitor.config";

/** Relayer balance and fee-spend monitoring. Imported by the worker. */
@Module({
  imports: [AlertingModule],
  providers: [
    {
      provide: RelayerBalanceMonitor,
      inject: [AlertingService, { token: MetricsService, optional: true }, { token: PipelineHeartbeat, optional: true }],
      useFactory: (alerting: AlertingService, metrics?: MetricsService, heartbeat?: PipelineHeartbeat) => {
        const config = loadRelayerMonitorConfig();
        const client = config.publicKey ? new HorizonRelayerClient(config.horizonUrl, config.publicKey) : null;
        return new RelayerBalanceMonitor(config, client, alerting, metrics, heartbeat);
      },
    },
  ],
  exports: [RelayerBalanceMonitor],
})
export class RelayerMonitorModule {}
