import { Injectable, Logger } from "@nestjs/common";
import { OracleEventRepository } from "../oracle/oracle-event.repository";
import { OracleReading } from "../oracle/oracle-reading";
import { OracleService } from "../oracle/oracle.service";
import { PolicyService, StoredPolicy } from "../policy/policy.service";
import { ClaimSettlementService } from "./claim-settlement.service";
import { ClaimResult } from "./claim-result";
import { ReconciliationService } from "./reconciliation.service";

const STALENESS_LIMIT_SECONDS = 1800;

export interface ScanOutcome {
  settled: ClaimResult[];
  counts: {
    scanned: number;
    triggered: number;
    settled: number;
    deferred: number;
    failedTransient: number;
    failedPermanent: number;
    failedIndeterminate: number;
    deadLettered: number;
  };
}

export interface DeadLetterEntry {
  policyId: string;
  holder: string;
  failureCount: number;
  lastError: string;
  reason: string;
  coverageType: number;
}

@Injectable()
export class ClaimService {
  private readonly logger = new Logger(ClaimService.name);
  private processedCount = 0;
  private payoutTotal = BigInt(0);
  private readonly history: ClaimResult[] = [];
  private readonly deadLetterClaims: DeadLetterEntry[] = [];
  private readonly failureCounts = new Map<string, number>();
  private readonly deadLetterPolicyIds = new Set<string>();

  private readonly oracleEventRepository?: OracleEventRepository;
  private readonly reconciliationService?: ReconciliationService;

  constructor(
    private readonly policyService: PolicyService,
    private readonly oracleService: OracleService,
    private readonly claimSettlementService: ClaimSettlementService,
    oracleEventRepositoryOrReconciliation?: OracleEventRepository | ReconciliationService,
    reconciliationService?: ReconciliationService
  ) {
    if (oracleEventRepositoryOrReconciliation && "record" in oracleEventRepositoryOrReconciliation) {
      this.oracleEventRepository = oracleEventRepositoryOrReconciliation as OracleEventRepository;
    }
    if (oracleEventRepositoryOrReconciliation && "recordFailedSettlement" in oracleEventRepositoryOrReconciliation) {
      this.reconciliationService = oracleEventRepositoryOrReconciliation as ReconciliationService;
    }
    if (reconciliationService) {
      this.reconciliationService = reconciliationService;
    }
  }

  async processTriggered(): Promise<ClaimResult[]> {
    return (await this.processTriggeredWithStats()).settled;
  }

  async settleClaims(): Promise<ClaimResult[]> {
    return this.processTriggered();
  }

  async processTriggeredWithStats(): Promise<ScanOutcome> {
    const activePolicies = this.policyService.listActive().filter((policy) => !this.deadLetterPolicyIds.has(policy.id));
    const settled: ClaimResult[] = [];
    const counts = {
      scanned: activePolicies.length,
      triggered: 0,
      settled: 0,
      deferred: 0,
      failedTransient: 0,
      failedPermanent: 0,
      failedIndeterminate: 0,
      deadLettered: 0,
    };

    for (const policy of activePolicies) {
      try {
        const fetchedAt = Math.floor(Date.now() / 1000);
        const oracle = await this.fetchOracleData(policy);
        const result = this.evaluatePolicy(policy, oracle, fetchedAt);
        if (!result.triggered) continue;

        counts.triggered += 1;
        const settledResult = await this.processPayout(policy, result);
        if (settledResult) {
          settled.push(settledResult);
          counts.settled += 1;
        } else {
          counts.deferred += 1;
          counts.failedTransient += 1;
        }
      } catch (err) {
        counts.failedIndeterminate += 1;
        this.logger.error(`Error scanning policy ${policy.id}`, err instanceof Error ? err.stack : String(err));
      }
    }

    counts.deadLettered = this.deadLetterClaims.length;
    return { settled, counts };
  }

  private async fetchOracleData(policy: StoredPolicy): Promise<OracleReading> {
    let reading: OracleReading;
    switch (policy.coverageType) {
      case 0:
        reading = await this.oracleService.checkStablecoinDepeg();
        break;
      case 1:
        reading = await this.oracleService.checkMarketCrash();
        break;
      case 2:
        reading = await this.oracleService.checkLiquidationShield();
        break;
      case 3:
        reading = await this.oracleService.checkSmartContractRisk();
        break;
      case 4: {
        const flightNumber = policy.triggerParams?.flightNumber;
        reading = await this.oracleService.checkFlightDelay(
          typeof flightNumber === "string" ? flightNumber : "UNKNOWN"
        );
        break;
      }
      default:
        throw new Error(`Unknown coverageType ${policy.coverageType}`);
    }

    void this.oracleEventRepository?.record(reading);
    return reading;
  }

  private evaluatePolicy(policy: StoredPolicy, oracle: OracleReading, fetchedAt: number): ClaimResult {
    const staleness = Math.floor(Date.now() / 1000) - fetchedAt;
    if (staleness > STALENESS_LIMIT_SECONDS) {
      return this.buildResult(policy, false, `Oracle data stale (${staleness}s old)`);
    }

    let triggered: boolean;
    switch (policy.coverageType) {
      case 4:
        triggered = oracle.value > oracle.threshold;
        break;
      default:
        triggered = oracle.value < oracle.threshold;
    }

    return this.buildResult(policy, triggered, oracle.message);
  }

  private buildResult(policy: StoredPolicy, triggered: boolean, reason: string): ClaimResult {
    return {
      policyId: policy.id,
      holder: policy.holder,
      coverageType: policy.coverageType,
      triggered,
      payout: triggered ? policy.coverageAmount : "0",
      reason,
      processedAt: Date.now(),
    };
  }

  private async processPayout(policy: StoredPolicy, result: ClaimResult): Promise<ClaimResult | undefined> {
    this.logger.warn(
      `PAYOUT triggered: policy=${policy.id} holder=${policy.holder} payout=${result.payout} reason="${result.reason}"`
    );

    const settlement = await this.claimSettlementService.settleClaim(policy.id);
    if (!settlement.settled) {
      const count = (this.failureCounts.get(policy.id) ?? 0) + 1;
      this.failureCounts.set(policy.id, count);
      this.reconciliationService?.recordFailedSettlement(policy.id);

      if (count >= 3) {
        this.deadLetterClaims.push({
          policyId: policy.id,
          holder: policy.holder,
          failureCount: count,
          lastError: settlement.error ?? "settlement failed",
          reason: result.reason,
          coverageType: policy.coverageType,
        });
        this.deadLetterPolicyIds.add(policy.id);
        this.failureCounts.delete(policy.id);
      }
      return undefined;
    }

    this.policyService.deactivate(policy.id);
    this.processedCount += 1;
    this.payoutTotal += BigInt(result.payout);
    const settledResult = { ...result, settlementTxHash: settlement.txHash };
    this.history.push(settledResult);
    return settledResult;
  }

  getDeadLetterClaims(): DeadLetterEntry[] {
    return [...this.deadLetterClaims];
  }

  getStats() {
    return {
      activePolicies: this.policyService.listActive().length,
      processedClaims: this.processedCount,
      totalPayout: this.payoutTotal.toString(),
      settlementConfigured: this.claimSettlementService.isConfigured(),
      deadLetterClaims: this.deadLetterClaims.length,
      settlementRetries: [...this.failureCounts.values()].reduce((sum, value) => sum + value, 0),
    };
  }

  getHistoryForHolder(address: string): ClaimResult[] {
    return this.history.filter((claim) => claim.holder === address).sort((a, b) => b.processedAt - a.processedAt);
  }

  getRecentSettlements(limit = 10): ClaimResult[] {
    return [...this.history].sort((a, b) => b.processedAt - a.processedAt).slice(0, limit);
  }
}
