import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import {
  COVERAGE_REQUIRED_FEEDS,
  ORACLE_FEEDS,
  OracleFeedId,
} from "../config/oracle-feed.config";

export interface FeedTrustStatus {
  feedId: string;
  healthy: boolean;
  confirmed: boolean;
  quorumRequired: number;
  quorumAvailable: number;
  observedAt: number | null;
  confirmedAt: number | null;
  reason?: string;
}

export interface CoverageAvailability {
  available: boolean;
  requiredFeeds: string[];
  unavailableFeeds: string[];
  reason?: string;
}

@Injectable()
export class OracleTrustService {
  private readonly feedStatuses = new Map<string, FeedTrustStatus>();
  private publisherConfigured = false;

  constructor(
    @Optional() private readonly configService?: ConfigService<AppConfig, true>,
  ) {}

  setPublisherConfigured(configured: boolean): void {
    this.publisherConfigured = configured;
  }

  recordObservation(
    feedId: string,
    healthy: boolean,
    reason?: string,
    observedAt: number = Date.now(),
  ): void {
    const configuration = ORACLE_FEEDS[feedId as OracleFeedId];
    if (!configuration) {
      throw new Error(`No oracle feed configuration exists for ${feedId}`);
    }
    this.feedStatuses.set(feedId, {
      feedId,
      healthy,
      confirmed: false,
      quorumRequired: configuration.requiredQuorum,
      quorumAvailable: healthy ? 1 : 0,
      observedAt,
      confirmedAt: null,
      reason: healthy ? undefined : reason ?? "source is unreachable or payload was rejected",
    });
  }

  recordPublication(feedId: string, confirmed: boolean, reason?: string): void {
    const current = this.feedStatuses.get(feedId);
    if (!current) {
      return;
    }
    this.feedStatuses.set(feedId, {
      ...current,
      confirmed,
      confirmedAt: confirmed ? Date.now() : null,
      reason: confirmed ? undefined : reason ?? "on-chain publication is not confirmed",
    });
  }

  feedStatus(feedId: string): FeedTrustStatus {
    const existing = this.feedStatuses.get(feedId);
    if (existing) return { ...existing };
    return {
      feedId,
      healthy: false,
      confirmed: false,
      quorumRequired: ORACLE_FEEDS[feedId as OracleFeedId]?.requiredQuorum ?? 1,
      quorumAvailable: 0,
      observedAt: null,
      confirmedAt: null,
      reason: "no accepted observation or on-chain confirmation",
    };
  }

  canPublish(feedId: string): boolean {
    const status = this.feedStatus(feedId);
    const budget = ORACLE_FEEDS[feedId as OracleFeedId]?.latencyBudgetMs;
    return (
      budget !== undefined &&
      status.healthy &&
      status.quorumAvailable >= status.quorumRequired &&
      status.observedAt !== null &&
      Date.now() - status.observedAt <= budget
    );
  }

  getCoverageAvailability(coverageType: string): CoverageAvailability {
    const requiredFeeds =
      COVERAGE_REQUIRED_FEEDS[coverageType as keyof typeof COVERAGE_REQUIRED_FEEDS];
    if (!requiredFeeds) {
      return {
        available: false,
        requiredFeeds: [],
        unavailableFeeds: [],
        reason: "coverage type has no configured feed dependencies",
      };
    }
    const unavailableFeeds = requiredFeeds.filter((feedId) => {
      const status = this.feedStatus(feedId);
      const budget = ORACLE_FEEDS[feedId]?.latencyBudgetMs ?? 0;
      const isFresh = status.observedAt !== null && Date.now() - status.observedAt <= budget;
      return (
        !status.healthy ||
        !status.confirmed ||
        status.quorumAvailable < status.quorumRequired ||
        !isFresh
      );
    });
    return {
      available: unavailableFeeds.length === 0,
      requiredFeeds: [...requiredFeeds],
      unavailableFeeds,
      reason:
        unavailableFeeds.length === 0
          ? undefined
          : `required feed(s) unavailable or unconfirmed: ${unavailableFeeds.join(", ")}`,
    };
  }

  readiness(): {
    sourcesReachable: boolean;
    quorumSatisfiable: boolean;
    publisherConfigured: boolean;
    feeds: FeedTrustStatus[];
    trustMode: "strict" | "quorum" | "development";
  } {
    const trustMode = parseTrustMode(
      this.configService?.get("oracleTrustMode", { infer: true }) ??
        process.env.ORACLE_TRUST_MODE,
    );
    const entries = Object.entries(ORACLE_FEEDS).filter(
      ([, config]) => trustMode !== "development" || config.sourceType !== "mock",
    );
    const feeds = entries.map(([feedId, configuration]) => {
      const status = this.feedStatus(feedId);
      const stale =
        status.observedAt === null ||
        Date.now() - status.observedAt > configuration.latencyBudgetMs;
      return stale
        ? {
            ...status,
            healthy: false,
            quorumAvailable: 0,
            reason: "source observation is missing or stale",
          }
        : status;
    });
    const sourcesReachable = feeds.every((feed) => feed.healthy);
    const quorumSatisfiable = feeds.every(
      (feed) => feed.quorumAvailable >= feed.quorumRequired,
    );
    return {
      sourcesReachable,
      quorumSatisfiable,
      publisherConfigured: this.publisherConfigured,
      feeds,
      trustMode,
    };
  }
}

function parseTrustMode(value: string | undefined): "strict" | "quorum" | "development" {
  if (value === "quorum" || value === "development") return value;
  return "strict";
}
