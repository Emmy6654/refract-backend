import { Global, Module } from "@nestjs/common";
import { PipelineHeartbeat } from "./pipeline-heartbeat";

/**
 * Worker-only runtime services. Global so schedulers inside feature modules
 * (oracle, claim, relayer monitor) can inject PipelineHeartbeat.
 */
@Global()
@Module({
  providers: [{ provide: PipelineHeartbeat, useFactory: () => new PipelineHeartbeat() }],
  exports: [PipelineHeartbeat],
})
export class RuntimeModule {}
