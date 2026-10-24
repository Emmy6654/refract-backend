import { BadRequestException, Injectable, Optional } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

const uuidv4 = randomUUID;
import { AppConfig } from "../config/configuration";
import { MetricsService } from "../metrics/metrics.service";
import { BuyPolicyDto } from "./dto/buy-policy.dto";
import { OracleTrustService } from "../oracle/oracle-trust.service";

const FLIGHT_DELAY_COVERAGE_TYPE = 4;
const COVERAGE_TYPE_VARIANTS = [
  "StablecoinDepeg",
  "MarketCrash",
  "LiquidationShield",
  "SmartContractRisk",
  "FlightDelay",
] as const;
const TRIGGER_THRESHOLDS = [500, 3000, 500, 500, 120];
const RISK_MULTIPLIERS = [1.0, 1.5, 2.0, 3.0, 0.8];
export const BASE_RATE_BPS_PARAM_KEY = "base_rate_bps";
const DEFAULT_BASE_RATE_BPS = 300;

export interface CoverageTypeCatalogEntry {
  id: number;
  name: string;
  description: string;
  riskLevel: string;
  riskMultiplier: number;
  baseRatePct: number;
  maxCoverage: number;
  trigger: string;
  icon: string;
  available: boolean;
  requiredFeeds: string[];
  unavailableReason?: string;
}

export interface StoredPolicy {
  id: string;
  holder: string;
  coverageType: number;
  coverageTypeName: string;
  coverageAmount: string;
  premium: string;
  durationDays: number;
  expiresAt: number;
  isActive: boolean;
  createdAt: string;
  triggerParams?: Record<string, unknown>;
}

export interface ProtocolParametersReader {
  getNumber(key: string, fallback: number): number;
}

const COVERAGE_NAMES = [
  "Stablecoin Depeg",
  "Market Crash",
  "Liquidation Shield",
  "Smart Contract Risk",
  "Flight Delay",
];

const COVERAGE_TYPES: CoverageTypeCatalogEntry[] = [
  {
    id: 0,
    name: "Stablecoin Depeg",
    description: "Pays out if a major stablecoin depegs below $0.95",
    riskLevel: "medium",
    riskMultiplier: 1.0,
    baseRatePct: 3.0,
    maxCoverage: 100_000,
    trigger: "USDC price < $0.95 for 15+ minutes",
    icon: "🪙",
    available: true,
    requiredFeeds: [],
  },
  {
    id: 1,
    name: "Market Crash",
    description: "Covers catastrophic market downturns exceeding 30% in 24h",
    riskLevel: "high",
    riskMultiplier: 1.5,
    baseRatePct: 4.5,
    maxCoverage: 50_000,
    trigger: "Market index 24h return < -30%",
    icon: "📉",
    available: true,
    requiredFeeds: [],
  },
  {
    id: 2,
    name: "Liquidation Shield",
    description: "Pays out if your DeFi position gets liquidated",
    riskLevel: "high",
    riskMultiplier: 2.0,
    baseRatePct: 6.0,
    maxCoverage: 200_000,
    trigger: "Collateral ratio drops below maintenance threshold",
    icon: "🛡️",
    available: true,
    requiredFeeds: [],
  },
  {
    id: 3,
    name: "Smart Contract Risk",
    description: "Protection against smart contract exploits and hacks",
    riskLevel: "critical",
    riskMultiplier: 3.0,
    baseRatePct: 9.0,
    maxCoverage: 500_000,
    trigger: "Covered protocol TVL drops >50% in <1 hour",
    icon: "🔐",
    available: true,
    requiredFeeds: [],
  },
  {
    id: 4,
    name: "Flight Delay",
    description: "Automatic payout for flight delays over 2 hours",
    riskLevel: "low",
    riskMultiplier: 0.8,
    baseRatePct: 2.4,
    maxCoverage: 2_000,
    trigger: "Flight delayed > 120 minutes per AviationStack data",
    icon: "✈️",
    available: true,
    requiredFeeds: [],
  },
];

@Injectable()
export class PolicyService {
  private readonly policies = new Map<string, StoredPolicy>();
  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;
  private readonly poolContractId: string;

  constructor(
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly metricsService: MetricsService,
    private readonly parameters?: ProtocolParametersReader,
    @Optional() private readonly oracleTrust?: OracleTrustService,
  ) {
    const stellar = this.configService.get("stellar", { infer: true });
    this.server = new rpc.Server(stellar.sorobanRpcUrl);
    this.networkPassphrase = stellar.networkPassphrase;
    this.poolContractId = stellar.poolContractId;
  }

  private baseRateBps(): number {
    return this.parameters?.getNumber(BASE_RATE_BPS_PARAM_KEY, DEFAULT_BASE_RATE_BPS) ?? DEFAULT_BASE_RATE_BPS;
  }

  private buildPolicyParamsScVal(
    coverageType: number,
    coverageAmount: bigint,
    durationDays: number,
    triggerThreshold: number
  ): xdr.ScVal {
    return xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("coverage_amount"),
        val: nativeToScVal(coverageAmount, { type: "i128" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("coverage_type"),
        val: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(COVERAGE_TYPE_VARIANTS[coverageType])]),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("duration_days"),
        val: nativeToScVal(durationDays, { type: "u32" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("trigger_threshold"),
        val: nativeToScVal(triggerThreshold, { type: "i128" }),
      }),
    ]);
  }

  private async buildUnsignedBuyInvoke(holder: string, paramsScVal: xdr.ScVal): Promise<string> {
    if (!this.poolContractId) {
      throw new BadRequestException({ error: "Pool contract not configured (missing REFRACT_POOL_CONTRACT_ID)" });
    }
    try {
      const sourceAccount = await this.metricsService.observeSorobanRpc("get_account", () =>
        this.server.getAccount(holder)
      );
      const contract = new Contract(this.poolContractId);
      const operation = contract.call("buy_policy", new Address(holder).toScVal(), paramsScVal);

      const builtTx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      const preparedTx = await this.metricsService.observeSorobanRpc("prepare_transaction", () =>
        this.server.prepareTransaction(builtTx)
      );
      return preparedTx.toXDR();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BadRequestException({ error: `Failed to build Soroban transaction: ${message}` });
    }
  }

  async onChainCoverageBounds(): Promise<{ minCoverage: bigint; maxCoverage: bigint } | null> {
    if (!this.poolContractId) {
      return null;
    }
    try {
      // pool_config() is a stateless view with no caller-specific args, so
      // the source account only needs to be well-formed for the tx
      // envelope — it never touches the network, unlike getAccount().
      const dummySource = new Account(Keypair.random().publicKey(), "0");
      const contract = new Contract(this.poolContractId);
      const tx = new TransactionBuilder(dummySource, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(contract.call("pool_config"))
        .setTimeout(30)
        .build();

      const sim = await this.metricsService.observeSorobanRpc("simulate_transaction", () =>
        this.server.simulateTransaction(tx)
      );
      if (rpc.Api.isSimulationError(sim)) {
        throw new Error(sim.error);
      }
      const config = scValToNative(sim.result!.retval) as {
        min_coverage: bigint;
        max_coverage: bigint;
      } | null;
      if (!config) return null;
      return { minCoverage: config.min_coverage, maxCoverage: config.max_coverage };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BadRequestException({ error: `Failed to read pool config: ${message}` });
    }
  }

  listTypes(): CoverageTypeCatalogEntry[] {
    return COVERAGE_TYPES.map((entry) => {
      const availability = this.oracleTrust?.getCoverageAvailability(COVERAGE_TYPE_VARIANTS[entry.id]);
      return {
        ...entry,
        available: availability?.available ?? true,
        requiredFeeds: availability?.requiredFeeds ?? [],
        unavailableReason: availability?.reason,
      };
    });
  }

  findByHolder(address: string): StoredPolicy[] {
    return [...this.policies.values()].filter((p) => p.holder === address);
  }

  findById(id: string): StoredPolicy | undefined {
    return this.policies.get(id);
  }

  listActive(): StoredPolicy[] {
    const now = Math.floor(Date.now() / 1000);
    return [...this.policies.values()].filter((p) => p.isActive && p.expiresAt > now);
  }

  deactivate(id: string): void {
    const policy = this.policies.get(id);
    if (policy) {
      policy.isActive = false;
      this.policies.set(id, policy);
    }
  }

  async simulateBuy(dto: BuyPolicyDto): Promise<{ policy: StoredPolicy; txXdr: string; message: string }> {
    const { holder, coverageType, coverageAmount, durationDays, triggerParams } = dto;

    const catalogEntry = COVERAGE_TYPES[coverageType];
    if (!catalogEntry) {
      throw new BadRequestException({
        error: `coverageType must be between 0 and ${COVERAGE_TYPES.length - 1}`,
      });
    }

    if (coverageType === FLIGHT_DELAY_COVERAGE_TYPE && typeof triggerParams?.flightNumber !== "string") {
      throw new BadRequestException({
        error: "Flight Delay coverage requires triggerParams.flightNumber",
      });
    }

    const coverage = BigInt(coverageAmount);
    if (coverage <= 0n) {
      throw new BadRequestException({ error: "coverageAmount must be greater than zero" });
    }

    const maxCoverage = catalogEntry.maxCoverage;
    if (coverage > BigInt(maxCoverage) * 10_000_000n) {
      throw new BadRequestException({
        error: `coverageAmount exceeds the ${COVERAGE_NAMES[coverageType]} maximum of ${maxCoverage} USDC`,
        maxCoverage,
      });
    }

    const bounds = await this.onChainCoverageBounds();
    if (bounds && (coverage < bounds.minCoverage || coverage > bounds.maxCoverage)) {
      throw new BadRequestException({
        error: `coverageAmount must be between ${bounds.minCoverage} and ${bounds.maxCoverage} (pool contract units) per the pool's current configuration`,
        minCoverage: bounds.minCoverage.toString(),
        maxCoverage: bounds.maxCoverage.toString(),
      });
    }

    const multiplier = RISK_MULTIPLIERS[coverageType];
    const annualRate = (this.baseRateBps() / 10_000) * multiplier;
    const dailyRate = annualRate / 365;
    const premiumFraction = dailyRate * durationDays;
    const premium = BigInt(Math.floor(Number(coverage) * premiumFraction));

    const policyId = uuidv4();
    const expiresAt = Math.floor(Date.now() / 1000) + durationDays * 86_400;
    const policy: StoredPolicy = {
      id: policyId,
      holder,
      coverageType,
      coverageTypeName: COVERAGE_NAMES[coverageType],
      coverageAmount,
      premium: premium.toString(),
      durationDays,
      expiresAt,
      isActive: true,
      createdAt: new Date().toISOString(),
      triggerParams,
    };

    const paramsScVal = this.buildPolicyParamsScVal(
      coverageType,
      coverage,
      durationDays,
      TRIGGER_THRESHOLDS[coverageType]
    );
    const txXdr = await this.buildUnsignedBuyInvoke(holder, paramsScVal);

    return { policy, txXdr, message: "Preview purchase" };
  }

  async buy(dto: BuyPolicyDto): Promise<{ policy: StoredPolicy; txXdr: string; message: string }> {
    const { holder, coverageType, coverageAmount, durationDays, triggerParams } = dto;

    const catalogEntry = COVERAGE_TYPES[coverageType];
    if (!catalogEntry) {
      throw new BadRequestException({
        error: `coverageType must be between 0 and ${COVERAGE_TYPES.length - 1}`,
      });
    }
    const coverageAvailability = this.oracleTrust?.getCoverageAvailability(
      COVERAGE_TYPE_VARIANTS[coverageType],
    );
    if (coverageAvailability && !coverageAvailability.available) {
      throw new BadRequestException({
        error: `${catalogEntry.name} coverage is unavailable`,
        requiredFeeds: coverageAvailability.requiredFeeds,
        unavailableFeeds: coverageAvailability.unavailableFeeds,
        reason: coverageAvailability.reason,
      });
    }

    if (coverageType === FLIGHT_DELAY_COVERAGE_TYPE && typeof triggerParams?.flightNumber !== "string") {
      throw new BadRequestException({
        error: "Flight Delay coverage requires triggerParams.flightNumber",
      });
    }

    const coverage = BigInt(coverageAmount);
    if (coverage <= 0n) {
      throw new BadRequestException({ error: "coverageAmount must be greater than zero" });
    }

    const maxCoverage = catalogEntry.maxCoverage;
    if (coverage > BigInt(maxCoverage) * 10_000_000n) {
      throw new BadRequestException({
        error: `coverageAmount exceeds the ${COVERAGE_NAMES[coverageType]} maximum of ${maxCoverage} USDC`,
        maxCoverage,
      });
    }

    const bounds = await this.onChainCoverageBounds();
    if (bounds && (coverage < bounds.minCoverage || coverage > bounds.maxCoverage)) {
      throw new BadRequestException({
        error: `coverageAmount must be between ${bounds.minCoverage} and ${bounds.maxCoverage} (pool contract units) per the pool's current configuration`,
        minCoverage: bounds.minCoverage.toString(),
        maxCoverage: bounds.maxCoverage.toString(),
      });
    }

    const multiplier = RISK_MULTIPLIERS[coverageType];
    const annualRate = (this.baseRateBps() / 10_000) * multiplier; // bps -> fraction, e.g. 300bps * 1.0 = 0.03 (3%)
    const dailyRate = annualRate / 365;
    const premiumFraction = dailyRate * durationDays;
    const premium = BigInt(Math.floor(Number(coverage) * premiumFraction));

    const policyId = uuidv4();
    const expiresAt = Math.floor(Date.now() / 1000) + durationDays * 86_400;

    const policy: StoredPolicy = {
      id: policyId,
      holder,
      coverageType,
      coverageTypeName: COVERAGE_NAMES[coverageType],
      coverageAmount,
      premium: premium.toString(),
      durationDays,
      expiresAt,
      isActive: true,
      createdAt: new Date().toISOString(),
      triggerParams,
    };

    this.policies.set(policyId, policy);

    const paramsScVal = this.buildPolicyParamsScVal(
      coverageType,
      coverage,
      durationDays,
      TRIGGER_THRESHOLDS[coverageType]
    );
    const txXdr = await this.buildUnsignedBuyInvoke(holder, paramsScVal);

    return { policy, txXdr, message: "Sign and submit to activate coverage" };
  }
}
