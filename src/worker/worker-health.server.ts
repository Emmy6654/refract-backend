import * as http from "http";
import { AddressInfo } from "net";
import { PipelineHeartbeat } from "../runtime/pipeline-heartbeat";

export interface WorkerHealthSources {
  heartbeat: PipelineHeartbeat;
  /** Prometheus exposition, if metrics are available in this process. */
  metrics?: () => Promise<{ body: string; contentType: string }>;
}

/**
 * Minimal HTTP listener for the worker: `/health` for liveness/readiness
 * probes and `/metrics` for Prometheus. The worker has no API, so this is
 * deliberately not an Express/Nest app — nothing here accepts input.
 *
 * `/health` returns 503 when a pipeline stage has stopped succeeding, so
 * the orchestrator restarts the worker without touching the API tier.
 */
export function startWorkerHealthServer(
  sources: WorkerHealthSources,
  port: number,
  host = "0.0.0.0"
): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    void handle(req, res, sources);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, sources: WorkerHealthSources) {
  const path = (req.url ?? "/").split("?")[0];
  if (req.method !== "GET") {
    res.writeHead(405, { Allow: "GET" }).end();
    return;
  }
  try {
    if (path === "/health") {
      const status = sources.heartbeat.status();
      res
        .writeHead(status.healthy ? 200 : 503, { "Content-Type": "application/json" })
        .end(JSON.stringify({ status: status.healthy ? "ok" : "stale", role: "worker", ...status }));
      return;
    }
    if (path === "/metrics" && sources.metrics) {
      const { body, contentType } = await sources.metrics();
      res.writeHead(200, { "Content-Type": contentType }).end(body);
      return;
    }
    res.writeHead(404).end();
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: (err as Error).message }));
  }
}

export function boundPort(server: http.Server): number {
  return (server.address() as AddressInfo).port;
}
