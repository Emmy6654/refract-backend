import { Logger } from "@nestjs/common";

/**
 * Hard upper bound on how long we wait for in-flight work (HTTP requests,
 * scheduler runs, connection-pool drains) to finish before forcing exit.
 * Prevents a stuck settlement from hanging the process forever.
 */
export const SHUTDOWN_GRACE_PERIOD_MS = Number(process.env.SHUTDOWN_GRACE_PERIOD_MS ?? 30_000);

/**
 * Install SIGTERM/SIGINT handlers that run `close()` once, bounded by the
 * grace period, then exit. Shared by the API (main.ts) and worker
 * (worker.ts) entrypoints so both tiers drain the same way.
 */
export function installGracefulShutdown(
  close: () => Promise<void>,
  logger: Logger,
  graceMs: number = SHUTDOWN_GRACE_PERIOD_MS,
  exit: (code: number) => void = (code) => process.exit(code)
): (signal: NodeJS.Signals) => Promise<void> {
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      logger.warn(`Received ${signal} while already shutting down; ignoring`);
      return;
    }
    shuttingDown = true;
    logger.log(`Received ${signal}; starting graceful shutdown (grace period ${graceMs}ms)`);

    // If draining does not finish in time, log and exit so the orchestrator
    // is not left waiting on a stuck in-flight settlement.
    const forceExitTimer = setTimeout(() => {
      logger.error(`Graceful shutdown exceeded ${graceMs}ms; forcing exit`);
      exit(1);
    }, graceMs);
    forceExitTimer.unref();

    try {
      await close();
      clearTimeout(forceExitTimer);
      logger.log("Graceful shutdown complete");
      exit(0);
    } catch (err) {
      clearTimeout(forceExitTimer);
      logger.error(`Error during graceful shutdown: ${(err as Error).message}`, (err as Error).stack);
      exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  return shutdown;
}
