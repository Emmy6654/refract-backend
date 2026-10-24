import { FeeSpendRecord } from "./fee-spend-tracker";
import { RelayerAccountSnapshot, parseXlmToStroops } from "./relayer-balance.policy";

export class RelayerAccountNotFoundError extends Error {
  constructor(publicKey: string) {
    super(`Relayer account ${publicKey} does not exist on the network (unfunded or wrong network)`);
    this.name = "RelayerAccountNotFoundError";
  }
}

export interface FeeSpendPage {
  records: FeeSpendRecord[];
  /** Paging token to resume after; null when the page was empty. */
  cursor: string | null;
}

type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

interface HorizonBalance {
  asset_type: string;
  balance: string;
  selling_liabilities?: string;
}

interface HorizonAccount {
  balances: HorizonBalance[];
  subentry_count: number;
  num_sponsoring?: number;
  num_sponsored?: number;
}

interface HorizonTransaction {
  hash: string;
  paging_token: string;
  fee_charged: string | number;
  fee_account?: string;
  source_account: string;
  successful: boolean;
  created_at: string;
}

/**
 * Reads the relayer's balance and fee history from Horizon.
 *
 * Soroban RPC's getAccount returns only the sequence number, so balances
 * and per-transaction `fee_charged` come from Horizon. Only the public key
 * is needed — the monitor never touches the relayer secret.
 */
export class HorizonRelayerClient {
  constructor(
    private readonly horizonUrl: string,
    private readonly publicKey: string,
    private readonly timeoutMs = 10_000,
    private readonly fetchFn: FetchFn = (url, init) => fetch(url, init)
  ) {}

  async getAccount(): Promise<RelayerAccountSnapshot> {
    const res = await this.get(`/accounts/${this.publicKey}`);
    if (res.status === 404) throw new RelayerAccountNotFoundError(this.publicKey);
    if (!res.ok) throw new Error(`Horizon /accounts returned HTTP ${res.status}`);
    const body = (await res.json()) as HorizonAccount;
    const native = body.balances?.find((b) => b.asset_type === "native");
    if (!native) throw new Error("Horizon account has no native balance");
    return {
      balanceStroops: parseXlmToStroops(native.balance),
      sellingLiabilitiesStroops: parseXlmToStroops(native.selling_liabilities ?? "0"),
      subentryCount: Number(body.subentry_count ?? 0),
      numSponsoring: Number(body.num_sponsoring ?? 0),
      numSponsored: Number(body.num_sponsored ?? 0),
    };
  }

  /**
   * Transactions whose fee the relayer paid, oldest first, starting after
   * `cursor`. Without a cursor, returns the most recent page (to backfill
   * the window on startup) and a cursor pointing at the newest one.
   */
  async listFeeSpend(cursor: string | null, limit = 200): Promise<FeeSpendPage> {
    const order = cursor ? "asc" : "desc";
    const params = new URLSearchParams({ order, limit: String(limit), include_failed: "true" });
    if (cursor) params.set("cursor", cursor);
    const res = await this.get(`/accounts/${this.publicKey}/transactions?${params}`);
    if (res.status === 404) throw new RelayerAccountNotFoundError(this.publicKey);
    if (!res.ok) throw new Error(`Horizon /transactions returned HTTP ${res.status}`);

    const body = (await res.json()) as { _embedded?: { records?: HorizonTransaction[] } };
    const txs = [...(body._embedded?.records ?? [])];
    if (order === "desc") txs.reverse();

    const records = txs
      // Fee-bumped transactions are charged to the fee account; only count
      // what the relayer itself paid.
      .filter((tx) => (tx.fee_account ?? tx.source_account) === this.publicKey)
      .map((tx) => ({
        txHash: tx.hash,
        feeChargedStroops: BigInt(tx.fee_charged),
        at: Date.parse(tx.created_at),
        successful: Boolean(tx.successful),
      }));
    const newest = txs[txs.length - 1];
    return { records, cursor: newest ? newest.paging_token : cursor };
  }

  private get(path: string) {
    const base = this.horizonUrl.replace(/\/+$/, "");
    return this.fetchFn(`${base}${path}`, { signal: AbortSignal.timeout(this.timeoutMs) });
  }
}
