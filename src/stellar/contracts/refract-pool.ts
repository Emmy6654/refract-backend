import { Address, Contract, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

export function poolOperation(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): ReturnType<Contract["call"]> {
  return new Contract(contractId).call(method, ...args);
}

export function encodeLockupExpiresAt(provider: string): xdr.ScVal[] {
  return [new Address(provider).toScVal()];
}

export function encodeProviderPosition(provider: string): xdr.ScVal[] {
  return [new Address(provider).toScVal()];
}

export function encodeProvideCapital(provider: string, amount: bigint): xdr.ScVal[] {
  return [new Address(provider).toScVal(), nativeToScVal(amount, { type: "i128" })];
}

export function encodeWithdrawCapital(provider: string, shares: bigint): xdr.ScVal[] {
  return [new Address(provider).toScVal(), nativeToScVal(shares, { type: "i128" })];
}

export function decodeLockupExpiresAt(value: xdr.ScVal): bigint | null {
  const decoded = scValToNative(value);
  return decoded === null || decoded === undefined ? null : toBigInt(decoded, "lockup expiry");
}

export function decodeProviderPosition(value: xdr.ScVal): {
  shares: bigint;
  premiumEarned: bigint;
} {
  return { shares: toBigInt(scValToNative(value), "share balance"), premiumEarned: 0n };
}

export function decodePoolState(value: xdr.ScVal): {
  totalUsdc: bigint;
  totalShares: bigint;
} {
  const decoded = scValToNative(value);
  const fields = toRecord(decoded, "pool stats");
  return {
    totalUsdc: toBigInt(fields.total_capital, "total capital"),
    totalShares: toBigInt(fields.total_shares, "total shares"),
  };
}

function toRecord(value: unknown, name: string): Record<string, unknown> {
  if (value instanceof Map) {
    const record: Record<string, unknown> = {};
    for (const [key, entry] of value) {
      record[String(key)] = entry;
    }
    return record;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`Unexpected ${name} response`);
}

function toBigInt(value: unknown, name: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new Error(`Unexpected ${name} response`);
}
