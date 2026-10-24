import { Injectable } from "@nestjs/common";

export interface HeartbeatStatus {
  healthy: boolean;
  startedAt: number;
  /** Last successful run per pipeline stage (epoch ms). */
  lastBeats: Record<string, number>;
  /** Stages that have not succeeded within `staleAfterMs`. */
  staleStages: string[];
}

/**
 * Records when each pipeline stage last completed, so the worker's health
 * endpoint can report a stuck pipeline and the orchestrator can restart it.
 *
 * A stage counts as stale only after it has been registered with `expect()`
 * and the grace period since startup has passed without a beat.
 */
@Injectable()
export class PipelineHeartbeat {
  private readonly startedAt: number;
  private readonly beats = new Map<string, number>();
  private readonly expected = new Set<string>();

  constructor(
    private readonly staleAfterMs: number = Number(process.env.WORKER_STALE_AFTER_MS ?? 10 * 60_000),
    private readonly now: () => number = Date.now
  ) {
    this.startedAt = this.now();
  }

  /** Declare a stage that must keep beating for the worker to be healthy. */
  expect(stage: string): void {
    this.expected.add(stage);
  }

  beat(stage: string): void {
    this.beats.set(stage, this.now());
  }

  status(): HeartbeatStatus {
    const now = this.now();
    const staleStages = [...this.expected]
      .filter((stage) => now - (this.beats.get(stage) ?? this.startedAt) > this.staleAfterMs)
      .sort();
    return {
      healthy: staleStages.length === 0,
      startedAt: this.startedAt,
      lastBeats: Object.fromEntries(this.beats),
      staleStages,
    };
  }
}
