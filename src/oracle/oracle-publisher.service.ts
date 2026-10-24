import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BASE_FEE, Contract, Keypair, TransactionBuilder, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { MetricsService } from "../metrics/metrics.service";
import { OracleTrustService } from "./oracle-trust.service";
import { pollForConfirmation } from "../stellar/soroban-confirmation.util";
import { OracleReading } from "./oracle-reading";
import { coverageTypeToU32, scaleOracleValue } from "./oracle-encoding";

export interface OraclePublishRecord {
  coverageType: string;
  scaledValue: string;
  txHash?: string;
  confirmed: boolean;
  outcome?: string;
  error?: string;
  attemptedAt: number;
}

/**
 * Relayer path that pushes oracle readings to RefractOracle via
 * `update_reading(coverage_type: u32, value: i128)`.
 *
 * Mirrors ClaimSettlementService's build/prepare/sign/send/poll structure.
 * Degraded fail-safe readings are never published — treating an outage
 * placeholder as authoritative on-chain data would be a safety failure.
 */
@Injectable()
export class OraclePublisherService {
  private readonly logger = new Logger(OraclePublisherService.name);
  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;
  private readonly oracleContractId: string;
  private readonly relayerKeypair: Keypair | null;
  private readonly publishMode: AppConfig["oraclePublish"]["mode"];
  private readonly minIntervalMs: number;
  private readonly confirmationDefaults: AppConfig["confirmation"];

  private readonly lastScaled = new Map<string, bigint>();
  private readonly lastPublishedAt = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private readonly auditLog: OraclePublishRecord[] = [];

  constructor(
    private readonly configService: ConfigService<AppConfig, true>,
    @Optional() private readonly metricsService?: MetricsService,
    @Optional() private readonly oracleTrustService?: OracleTrustService,
  ) {
    const stellar = this.configService.get("stellar", { infer: true });
    this.server = new rpc.Server(stellar.sorobanRpcUrl);
    this.networkPassphrase = stellar.networkPassphrase;
    this.oracleContractId = stellar.oracleContractId;
    this.relayerKeypair = stellar.relayerSecret ? Keypair.fromSecret(stellar.relayerSecret) : null;
    const publish = this.configService.get("oraclePublish", { infer: true });
    this.publishMode = publish.mode;
    this.minIntervalMs = publish.minIntervalMs;
    this.confirmationDefaults = this.configService.get("confirmation", { infer: true });
    this.oracleTrustService?.setPublisherConfigured(this.isConfigured());
  }

  /** True once an oracle contract ID and relayer secret are configured. */
  isConfigured(): boolean {
    return Boolean(this.oracleContractId && this.relayerKeypair);
  }

  getAuditLog(): readonly OraclePublishRecord[] {
    return this.auditLog;
  }

  /**
   * Decide whether to publish and, if so, submit. Never throws — degrades
   * with a clear log when unconfigured (same posture as ClaimSettlementService).
   */
  async maybePublish(
    reading: OracleReading,
    deadlineAt: number | undefined = reading.deadlineAt,
  ): Promise<OraclePublishRecord | null> {
    const feedId = reading.feedId ?? reading.coverageType;
    if (reading.degraded) {
      this.logger.warn(`Skipping on-chain publish for degraded ${reading.coverageType} reading`);
      this.oracleTrustService?.recordPublication(feedId, false, "provider reading is degraded");
      return null;
    }

    if (this.oracleTrustService && !this.oracleTrustService.canPublish(feedId)) {
      this.logger.warn(`Skipping on-chain publish for untrusted feed ${feedId}`);
      return null;
    }

    if (this.deadlineExpired(feedId, "publication", deadlineAt)) {
      this.oracleTrustService?.recordPublication(feedId, false, "publication deadline expired");
      return null;
    }

    if (!this.isConfigured()) {
      this.logger.debug(
        "Oracle publisher not configured (missing REFRACT_ORACLE_CONTRACT_ID or ORACLE_RELAYER_SECRET) — skipping"
      );
      return null;
    }

    let scaled: bigint;
    try {
      scaled = scaleOracleValue(reading.coverageType, reading.value);
    } catch (err) {
      this.logger.error(
        `Cannot scale oracle reading for ${reading.coverageType}`,
        err instanceof Error ? err.message : String(err)
      );
      return null;
    }

    const now = Date.now();
    const lastAt = this.lastPublishedAt.get(reading.coverageType) ?? 0;
    const previousValue = this.lastScaled.get(reading.coverageType);
    if (previousValue !== undefined && previousValue === scaled) {
      this.oracleTrustService?.recordPublication(feedId, true);
      if (this.publishMode === "on_change") return null;
    }

    if (now - lastAt < this.minIntervalMs) {
      return null;
    }

    if (this.inFlight.has(reading.coverageType)) {
      this.logger.warn(`Overlapping publish suppressed for ${reading.coverageType}`);
      return null;
    }

    this.inFlight.add(reading.coverageType);
    const publicationStartedAt = Date.now();
    try {
      const record = await this.publish(reading.coverageType, scaled, feedId, deadlineAt);
      this.auditLog.push(record);
      if (this.auditLog.length > 500) this.auditLog.shift();
      if (record.confirmed) {
        this.lastScaled.set(reading.coverageType, scaled);
        this.lastPublishedAt.set(reading.coverageType, Date.now());
      }
      this.oracleTrustService?.recordPublication(
        feedId,
        record.confirmed,
        record.error ?? record.outcome,
      );
      return record;
    } finally {
      this.metricsService?.recordOracleStage(
        feedId,
        "publication",
        (Date.now() - publicationStartedAt) / 1000,
      );
      this.inFlight.delete(reading.coverageType);
    }
  }

  private async publish(
    coverageType: string,
    scaledValue: bigint,
    feedId: string,
    deadlineAt?: number,
  ): Promise<OraclePublishRecord> {
    const attemptedAt = Date.now();
    const base: OraclePublishRecord = {
      coverageType,
      scaledValue: scaledValue.toString(10),
      confirmed: false,
      attemptedAt,
    };

    try {
      if (this.deadlineExpired(feedId, "publication", deadlineAt)) {
        return { ...base, error: "Feed publication deadline expired before RPC account lookup" };
      }
      const sourceAccount = await this.withinDeadline(
        feedId,
        "publication",
        deadlineAt,
        () => this.server.getAccount(this.relayerKeypair!.publicKey()),
      );
      if (this.deadlineExpired(feedId, "publication", deadlineAt)) {
        return { ...base, error: "Feed publication deadline expired before transaction preparation" };
      }
      const contract = new Contract(this.oracleContractId);
      // RefractOracle.update_reading(coverage_type: u32, value: i128)
      const operation = contract.call(
        "update_reading",
        nativeToScVal(coverageTypeToU32(coverageType), { type: "u32" }),
        nativeToScVal(scaledValue, { type: "i128" })
      );

      const remainingMs = deadlineAt === undefined ? 30_000 : deadlineAt - Date.now();
      const transactionTimeoutSeconds = Math.min(30, Math.floor(remainingMs / 1000));
      if (transactionTimeoutSeconds < 1) {
        this.metricsService?.recordOracleDeadlineBreach(
          feedId,
          "publication",
          Math.max(0, (1_000 - remainingMs) / 1_000),
        );
        return { ...base, error: "Insufficient latency budget remains for an on-chain transaction" };
      }

      const builtTx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(transactionTimeoutSeconds)
        .build();

      const preparedTx = await this.withinDeadline(
        feedId,
        "publication",
        deadlineAt,
        () => this.server.prepareTransaction(builtTx),
      );
      if (this.deadlineExpired(feedId, "publication", deadlineAt)) {
        return { ...base, error: "Feed publication deadline expired before transaction submission" };
      }
      preparedTx.sign(this.relayerKeypair!);

      const sendResult = await this.withinDeadline(
        feedId,
        "publication",
        deadlineAt,
        () => this.server.sendTransaction(preparedTx),
      );
      if (sendResult.status === "ERROR" || sendResult.status === "TRY_AGAIN_LATER") {
        const record = {
          ...base,
          txHash: sendResult.hash,
          error: `Submission not accepted: ${sendResult.status}`,
        };
        this.logger.error(`Oracle publish rejected for ${coverageType}: ${record.error}`);
        return record;
      }

      const confirmationStartedAt = Date.now();
      const confirmationDeadlineMs = deadlineAt === undefined
        ? this.confirmationDefaults.settlementDeadlineMs
        : Math.min(this.confirmationDefaults.settlementDeadlineMs, deadlineAt - Date.now());
      if (confirmationDeadlineMs <= 0) {
        this.deadlineExpired(feedId, "confirmation", deadlineAt);
        return {
          ...base,
          txHash: sendResult.hash,
          error: "Feed publication was submitted but its confirmation deadline expired",
        };
      }

      const confirmation = await this.withinDeadline(
        feedId,
        "confirmation",
        deadlineAt,
        () =>
          pollForConfirmation(this.server, sendResult.hash, {
            initialIntervalMs: this.confirmationDefaults.initialIntervalMs,
            backoffMultiplier: this.confirmationDefaults.backoffMultiplier,
            maxIntervalMs: this.confirmationDefaults.maxIntervalMs,
            jitterRatio: this.confirmationDefaults.jitterRatio,
            deadlineMs: confirmationDeadlineMs,
          }),
      );
      this.metricsService?.recordOracleStage(
        feedId,
        "confirmation",
        (Date.now() - confirmationStartedAt) / 1000,
      );
      if (this.deadlineExpired(feedId, "confirmation", deadlineAt)) {
        return {
          ...base,
          txHash: confirmation.txHash,
          outcome: confirmation.outcome,
          error: "Feed publication confirmation arrived after its deadline",
        };
      }

      const record: OraclePublishRecord = {
        ...base,
        txHash: confirmation.txHash,
        confirmed: confirmation.confirmed,
        outcome: confirmation.outcome,
        error: confirmation.error,
      };
      if (!record.confirmed) {
        this.logger.error(
          `Oracle publish did not confirm for ${coverageType}: outcome=${confirmation.outcome} error=${confirmation.error}`
        );
      } else {
        this.logger.log(`Oracle publish confirmed for ${coverageType}: tx=${confirmation.txHash} value=${scaledValue}`);
      }
      return record;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Oracle publish failed for ${coverageType}`, message);
      return { ...base, error: message };
    }
  }

  private deadlineExpired(feedId: string, stage: string, deadlineAt?: number): boolean {
    if (deadlineAt === undefined) {
      return false;
    }
    const overrunMs = Date.now() - deadlineAt;
    if (overrunMs < 0) {
      return false;
    }
    this.metricsService?.recordOracleDeadlineBreach(feedId, stage, Math.max(0, overrunMs / 1000));
    return true;
  }

  private async withinDeadline<T>(
    feedId: string,
    stage: string,
    deadlineAt: number | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (deadlineAt === undefined) {
      return operation();
    }
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      this.deadlineExpired(feedId, stage, deadlineAt);
      throw new Error(`Feed latency budget expired during ${stage}`);
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            this.deadlineExpired(feedId, stage, deadlineAt);
            reject(new Error(`Feed latency budget expired during ${stage}`));
          }, remainingMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}
