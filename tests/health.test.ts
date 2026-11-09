// Failure modes: /health returns 404 or fails to verify essential service connections (SQLite store, rules configuration, hub state, and worker status), or reports healthy when the rules file is broken; the visual console at / or its API endpoints fail to load state, validate/update rules, emit events, or query run timelines and logs.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("health");
const rulesFile = join(home, "rules.json");
writeFileSync(rulesFile, readFileSync(process.env.AGENT_AUTOLOOP_RULES!, "utf8"));
process.env.AGENT_AUTOLOOP_RULES = rulesFile;

const { startServer } = await import("../server.ts");

const app = await startServer(0, "127.0.0.1", { startWorker: false });
let base = "";

before(async () => {
  if (!app.server.listening) {
    await new Promise((resolve) => app.server.once("listening", resolve));
  }
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

after(() => {
  app.close();
});

test("visual console serves UI and API for configuration, workflow state, token usage, logs, and result queries", async () => {
  const htmlRes = await fetch(`${base}/`);
  assert.equal(htmlRes.status, 200);
  assert.match(htmlRes.headers.get("content-type") ?? "", /text\/html/);
  const html = await htmlRes.text();
  assert.ok(html.includes("Agent Autoloop"));

  const overviewRes = await fetch(`${base}/api/console/overview`);
  assert.equal(overviewRes.status, 200);
  const overview = (await overviewRes.json()) as any;
  assert.equal(overview.health.ok, true);
  assert.ok(overview.state.spending);
  assert.ok(Array.isArray(overview.state.runs));
  assert.ok(Array.isArray(overview.explain));
  assert.ok(Array.isArray(overview.keys));

  const emitRes = await fetch(`${base}/api/console/emit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: "app",
      type: "feedback.new",
      subject: "#101",
      summary: "用户反馈导出速度慢",
      detail: "报表超过 1 万行时导出耗时 15 秒",
    }),
  });
  assert.equal(emitRes.status, 200);
  const emitted = (await emitRes.json()) as any;
  assert.deepEqual(emitted.routed, ["意见"]);

  const afterEmit = (await (await fetch(`${base}/api/console/overview`)).json()) as any;
  assert.ok(afterEmit.state.runs.length >= 1);
  const runId = afterEmit.state.runs[0].id;

  const whyRes = await fetch(`${base}/api/console/runs/${runId}/why`);
  assert.equal(whyRes.status, 200);
  const whyData = (await whyRes.json()) as any;
  assert.ok(Array.isArray(whyData.facts));
  assert.match(whyData.formatted, /第 1 轮/);

  const logsRes = await fetch(`${base}/api/console/logs?after=0&limit=50`);
  assert.equal(logsRes.status, 200);
  const logsData = (await logsRes.json()) as any;
  assert.ok(Array.isArray(logsData.facts));
  assert.ok(logsData.facts.length > 0);
});

test("/health reports server status and connection to essential services, and degrades when rules are unreadable", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.ok, true);
  assert.equal(body.status, "ok");
  assert.equal(typeof body.commit, "string");
  assert.equal(typeof body.uptime, "number");
  assert.equal(body.services.database.status, "ok");
  assert.equal(body.services.database.connected, true);
  assert.equal(body.services.rules.status, "ok");
  assert.equal(body.services.hub.status, "ok");
  assert.equal(typeof body.services.worker.status, "string");

  writeFileSync(rulesFile, "{broken json");
  const degraded = await fetch(`${base}/health`);
  assert.equal(degraded.status, 503);
  const degradedBody = (await degraded.json()) as any;
  assert.equal(degradedBody.ok, false);
  assert.equal(degradedBody.status, "degraded");
  assert.equal(degradedBody.services.rules.status, "error");
});
