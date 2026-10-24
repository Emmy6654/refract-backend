/**
 * Which tier this process runs.
 *
 * - `api`    — HTTP + WebSocket only. Serves reads; never polls oracles,
 *              evaluates consensus, publishes on-chain or settles claims.
 * - `worker` — the payout pipeline (oracle polling, consensus, on-chain
 *              publishing, claim settlement, relayer monitoring). No HTTP API.
 * - `all`    — both in one process. Kept as the default so existing
 *              single-process deployments keep paying out until they are
 *              split; use it for local development only.
 *
 * `src/main.ts` starts the API (role from PROCESS_ROLE, default `all`);
 * `src/worker.ts` always runs as `worker`.
 */
export type ProcessRole = "api" | "worker" | "all";

export const PROCESS_ROLES: readonly ProcessRole[] = ["api", "worker", "all"];

export function resolveProcessRole(env: NodeJS.ProcessEnv = process.env): ProcessRole {
  const raw = (env.PROCESS_ROLE ?? "").trim().toLowerCase();
  if (raw === "") return "all";
  if ((PROCESS_ROLES as readonly string[]).includes(raw)) return raw as ProcessRole;
  throw new Error(`Invalid PROCESS_ROLE "${env.PROCESS_ROLE}". Expected one of: ${PROCESS_ROLES.join(", ")}`);
}

/** True when this process should run the payout pipeline (polling, consensus, settlement). */
export function runsPipeline(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveProcessRole(env) !== "api";
}

/** True when this process serves the HTTP API / WebSocket feed. */
export function servesApi(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveProcessRole(env) !== "worker";
}
