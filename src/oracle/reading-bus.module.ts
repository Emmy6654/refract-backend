import { Global, Inject, Module, OnApplicationShutdown } from "@nestjs/common";
import { ReadingBus, createReadingBus } from "./reading-bus";
import { resolveProcessRole } from "../runtime/process-role";

/**
 * Provides the ReadingBus to both tiers. Global so the oracle scheduler
 * (worker) and the feed relay (API) can inject it without import churn.
 */
@Global()
@Module({
  providers: [
    {
      provide: ReadingBus,
      useFactory: () => createReadingBus(resolveProcessRole()),
    },
  ],
  exports: [ReadingBus],
})
export class ReadingBusModule implements OnApplicationShutdown {
  constructor(@Inject(ReadingBus) private readonly bus: ReadingBus) {}

  async onApplicationShutdown(): Promise<void> {
    await this.bus.close();
  }
}
