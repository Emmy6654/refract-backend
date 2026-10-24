import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { ChainOracleStateReader } from "./reconciliation.stores";
import { OnChainOracleEntry, PublishKind } from "./chain-reconciliation.types";

/** The subset of SorobanRpcClient the reader needs (kept narrow for tests). */
export interface SorobanCaller {
  call<T>(operation: (server: rpc.Server) => Promise<T>): Promise<T>;
}

/** Turns one raw contract event into an oracle entry, or null to skip it. */
export type OracleEventDecoder = (event: rpc.Api.EventResponse) => OnChainOracleEntry | null;

/** Feed ids by the u32 discriminant used on-chain (see oracle-encoding.ts). */
const FEED_BY_U32 = ["StablecoinDepeg", "MarketCrash", "LiquidationShield", "SmartContractRisk", "FlightDelay"];

const KIND_BY_TOPIC: Record<string, PublishKind> = {
  reading: "reading",
  publish: "reading",
  decision: "decision",
};

/**
 * Default decoder for RefractOracle events. Expected layout:
 *
 *   topics: [Symbol("publish" | "reading" | "decision"), feed]
 *           where feed is a Symbol/String name or the u32 coverage discriminant
 *   value:  i128                                  (value only), or
 *           Map { value: i128, submitter: Address } (value + writer)
 *
 * Events with any other first topic are ignored. If refract-contracts emits a
 * different layout, pass a custom decoder instead of changing the reconciler.
 */
export const decodeRefractOracleEvent: OracleEventDecoder = (event) => {
  if (event.topic.length < 2) return null;
  const kind = KIND_BY_TOPIC[String(safeNative(event.topic[0]))];
  if (!kind) return null;

  const rawFeed = safeNative(event.topic[1]);
  const feedId = typeof rawFeed === "number" ? FEED_BY_U32[rawFeed] : typeof rawFeed === "string" ? rawFeed : undefined;
  if (!feedId) return null;

  const payload = safeNative(event.value);
  let value: unknown = payload;
  let submitter: string | undefined;
  if (payload && typeof payload === "object" && !(typeof payload === "bigint")) {
    const map = payload as Record<string, unknown>;
    value = map.value;
    submitter = typeof map.submitter === "string" ? map.submitter : undefined;
  }
  if (typeof value !== "bigint" && typeof value !== "number") return null;

  return {
    feedId,
    kind,
    value: BigInt(value).toString(),
    ledger: event.ledger,
    ledgerClosedAt: Math.floor(Date.parse(event.ledgerClosedAt) / 1000),
    txHash: event.txHash,
    submitter,
    eventId: event.id,
  };
};

function safeNative(val: xdr.ScVal): unknown {
  try {
    return scValToNative(val);
  } catch {
    return undefined;
  }
}

export interface SorobanChainStateReaderOptions {
  contractId: string;
  pageSize: number;
  /** Average ledger close time, used to turn a time lookback into a start ledger. */
  ledgerCloseSeconds?: number;
  decoder?: OracleEventDecoder;
  now?: () => number;
}

/**
 * Reads oracle writes back from Soroban via `getEvents`, paginating with the
 * RPC cursor and stopping at `maxEntries` so a reconciliation run has a
 * bounded RPC cost and cannot starve the publishing path.
 */
export class SorobanChainStateReader implements ChainOracleStateReader {
  private readonly decoder: OracleEventDecoder;
  private readonly ledgerCloseSeconds: number;
  private readonly now: () => number;

  constructor(private readonly rpcClient: SorobanCaller, private readonly opts: SorobanChainStateReaderOptions) {
    this.decoder = opts.decoder ?? decodeRefractOracleEvent;
    this.ledgerCloseSeconds = opts.ledgerCloseSeconds ?? 5;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async readSince(sinceSec: number, maxEntries: number): Promise<{ entries: OnChainOracleEntry[]; truncated: boolean }> {
    const latest = await this.rpcClient.call((server) => server.getLatestLedger());
    const ledgersBack = Math.ceil(Math.max(0, this.now() - sinceSec) / this.ledgerCloseSeconds) + 1;
    const startLedger = Math.max(1, latest.sequence - ledgersBack);
    const filters: rpc.Api.EventFilter[] = [{ type: "contract", contractIds: [this.opts.contractId] }];

    const entries: OnChainOracleEntry[] = [];
    let cursor: string | undefined;
    let truncated = false;
    // The budget counts raw events scanned, not decoded entries, so a
    // contract that emits many non-oracle events still has a bounded cost.
    let scanned = 0;

    for (;;) {
      const limit = Math.min(this.opts.pageSize, maxEntries - scanned);
      const request: rpc.Api.GetEventsRequest = cursor
        ? { filters, cursor, limit }
        : { filters, startLedger, limit };
      const page = await this.rpcClient.call((server) => server.getEvents(request));
      scanned += page.events.length;

      for (const event of page.events) {
        const entry = this.decoder(event);
        if (entry && entry.ledgerClosedAt >= sinceSec) entries.push(entry);
      }

      if (page.events.length < limit || !page.cursor) break;
      if (scanned >= maxEntries) {
        truncated = true;
        break;
      }
      cursor = page.cursor;
    }

    return { entries, truncated };
  }
}
