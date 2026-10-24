import { Server } from "http";
import { PipelineHeartbeat } from "../runtime/pipeline-heartbeat";
import { boundPort, startWorkerHealthServer } from "./worker-health.server";

describe("worker health server", () => {
  let server: Server | undefined;
  let now = 0;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function start(withMetrics = true) {
    now = 0;
    const heartbeat = new PipelineHeartbeat(100, () => now);
    heartbeat.expect("oracle");
    server = await startWorkerHealthServer(
      {
        heartbeat,
        metrics: withMetrics ? async () => ({ body: "refract_up 1\n", contentType: "text/plain" }) : undefined,
      },
      0,
      "127.0.0.1"
    );
    return { heartbeat, base: `http://127.0.0.1:${boundPort(server)}` };
  }

  it("reports ok while the pipeline is beating and 503 once it goes stale", async () => {
    const { heartbeat, base } = await start();

    let res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", role: "worker" });

    now = 500;
    res = await fetch(`${base}/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "stale", staleStages: ["oracle"] });

    heartbeat.beat("oracle");
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it("serves metrics when available and 404 otherwise", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("refract_up 1\n");
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it("accepts only GET", async () => {
    const { base } = await start(false);
    expect((await fetch(`${base}/health`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/metrics`)).status).toBe(404);
  });
});
