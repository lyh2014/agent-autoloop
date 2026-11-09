// Visual Console API and Single-Page Interface for Agent Autoloop.
// Operates strictly outside kernel/ through the host runtime's public doors.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { explainRules, previewEvent } from "./cli/explain.ts";
import { spendLine } from "./cli/spend.ts";
import { formatWhy } from "./cli/why.ts";
import { CONFIG_FILE, readConfig } from "./host/config.ts";
import { HOME, RULES_FILE } from "./host/home.ts";

const activeRulesPath = () =>
  process.env.AGENT_AUTOLOOP_RULES ? path.resolve(process.env.AGENT_AUTOLOOP_RULES) : RULES_FILE;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(data));
}

export async function seedInitialDemoData() {
  const hub = await import("./host/runtime.ts");
  const existingRuns = hub.all<{ id: number }>("SELECT id FROM runs LIMIT 1");
  if (existingRuns.length > 0) return { seeded: false };

  const now = Date.now();
  const activeFile = activeRulesPath();
  let rulesText = "";
  try {
    rulesText = readFileSync(activeFile, "utf8");
  } catch {
    return { seeded: false };
  }

  let parsedRules: any;
  try {
    parsedRules = JSON.parse(rulesText);
  } catch {
    return { seeded: false };
  }

  // Ensure rich default rules exist if only the minimal try rule is present
  if (
    parsedRules.rules?.length === 1 &&
    parsedRules.rules[0]?.name === "试一下" &&
    Object.keys(parsedRules.sources ?? {}).length === 1
  ) {
    const tryDir = path.join(HOME, "try");
    const enrichedRules = {
      timezone: "Asia/Shanghai",
      sources: {
        local: { name: "本机触发" },
        github: { name: "GitHub 仓库" },
        ops: { name: "生产告警" },
      },
      agents: {
        ...parsedRules.agents,
      },
      channels: {
        plain: { name: "网页卡片链接", links: true },
      },
      rules: [
        ...parsedRules.rules,
        {
          name: "Issue 自动分诊",
          when: { source: "github", types: ["issue.opened", "issue.labeled"] },
          to: Object.keys(parsedRules.agents)[0] ?? "agent",
          cwd: tryDir,
          group: "triage",
          parallel: 2,
          prompt: "阅读新建 Issue 内容，复现问题并给出修复方案；若涉及破坏性变更先发卡片询问。",
        },
        {
          name: "线上告警应急",
          when: { source: "ops", types: ["alert.*"] },
          to: Object.keys(parsedRules.agents)[0] ?? "agent",
          cwd: tryDir,
          group: "ops-incident",
          tell: "always",
          prompt: "检查服务状态与最近变更，汇总根因分析并通过卡片请求回滚或扩容拍板。",
        },
        {
          name: "每日工程早报",
          when: { cron: "0 9 * * *" },
          to: Object.keys(parsedRules.agents)[0] ?? "agent",
          cwd: tryDir,
          prompt: "汇总过去 24 小时合并的 PR、未决告警与 Token 消耗情况。",
        },
      ],
      elsewhere: [],
    };
    writeFileSync(activeFile, `${JSON.stringify(enrichedRules, null, 2)}\n`, { mode: 0o600 });
    hub.reloadRules(activeFile);
    parsedRules = enrichedRules;
  }

  const workerName = Object.values<any>(hub.rules.agents)[0]?.worker ?? "this-machine";

  // 1. Ingest a GitHub issue event and complete it with token usage
  const firstSource = hub.rules.sources.github ? "github" : Object.keys(hub.rules.sources)[0];
  const firstType = hub.rules.sources.github ? "issue.opened" : "try.start";
  hub.execute(
    "ingest",
    [
      firstSource,
      {
        id: `demo-issue-${now - 180_000}`,
        type: firstType,
        subject: "#42",
        summary: "导出大报表时偶发超时：当 CSV 行数超过 5 万行时响应超过 30 秒",
        detail: "堆栈定位于报表聚合查询未走复合索引，建议添加 (created_at, status) 索引并改为流式输出。",
      },
    ],
    now - 180_000,
  );

  const job1 = hub.execute("claimNext", [workerName, `demo-claim-1-${now}`], now - 175_000);
  if (job1) {
    hub.execute("started", [job1.run, job1.token, { session: "sess-triage-42" }], now - 170_000);
    hub.execute(
      "finish",
      [
        job1.run,
        job1.token,
        {
          outcome: "done",
          summary: "已定位慢查询原因并生成流式导出补丁，单测全部通过（耗时由 31s 降至 1.2s）",
          session: "sess-triage-42",
          usage: { input: 18420, output: 2640, cached: 6200, cost: 0.0684 },
        },
      ],
      now - 140_000,
    );
  }

  // 2. Ingest an Ops alert event that asks the owner a question (creates an open ask card)
  const secondSource = hub.rules.sources.ops ? "ops" : Object.keys(hub.rules.sources)[0];
  const secondType = hub.rules.sources.ops ? "alert.high_latency" : "try.ask";
  hub.execute(
    "ingest",
    [
      secondSource,
      {
        id: `demo-alert-${now - 60_000}`,
        type: secondType,
        subject: "service:api-gateway",
        summary: "api-gateway P99 延迟升至 1.8s，连接池使用率达到 94%",
        detail: "近 10 分钟请求量增长 2.4 倍，无错误率上升，属于突发性流量高峰。",
      },
    ],
    now - 60_000,
  );

  const job2 = hub.execute("claimNext", [workerName, `demo-claim-2-${now}`], now - 55_000);
  if (job2) {
    hub.execute("started", [job2.run, job2.token, { session: "sess-ops-88" }], now - 50_000);
    hub.execute(
      "finish",
      [
        job2.run,
        job2.token,
        {
          outcome: "done",
          summary: "已查明流量来源，等待拍板扩容或限流方案",
          session: "sess-ops-88",
          usage: { input: 12350, output: 1490, cached: 4100, cost: 0.0412 },
          ask: [
            {
              title: "网关连接池接近上限，如何处置？",
              text: "排查确认是合作伙伴批量同步任务触发的高峰，代码无异常。请选择下一步操作，你拍板后 Agent 将在同一会话接着执行：",
              options: ["临时将连接池与副本数扩至 2 倍", "对批量同步接口启用速率限制", "保持观察，暂不改动"],
              recommend: 0,
              key: "gateway-pool-decision",
              about: "根据你的选择执行扩容或限流并复查 P99 指标",
            },
          ],
        },
      ],
      now - 30_000,
    );
  }

  return { seeded: true };
}

export async function handleConsoleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  checkHealth: () => Promise<any>,
): Promise<boolean> {
  const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const { pathname } = reqUrl;
  const method = req.method ?? "GET";

  if (method === "GET" && (pathname === "/" || pathname === "/index.html" || pathname === "/console")) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(CONSOLE_HTML);
    return true;
  }

  if (!pathname.startsWith("/api/console/")) {
    return false;
  }

  const hub = await import("./host/runtime.ts");

  try {
    if (method === "GET" && pathname === "/api/console/overview") {
      const now = Date.now();
      const beforeParam = reqUrl.searchParams.get("before");
      const before = beforeParam ? Number(beforeParam) : undefined;
      const state = hub.stateOf(now, before) as any;
      const health = await checkHealth();
      const activeFile = activeRulesPath();
      const rulesRaw = existsSync(activeFile) ? readFileSync(activeFile, "utf8") : "{}";
      let explain: string[] = [];
      try {
        explain = explainRules(rulesRaw, now);
      } catch (err) {
        explain = [`规则解析提示：${(err as Error).message}`];
      }
      const keys = hub.listKeys();
      const config = existsSync(CONFIG_FILE) ? readConfig() : null;
      sendJson(res, {
        health,
        state,
        spendSummary: spendLine(state.spending),
        rulesRaw,
        rulesFile: activeFile,
        explain,
        keys,
        workerName: config?.worker?.name ?? null,
      });
      return true;
    }

    const whyMatch = /^\/api\/console\/runs\/([1-9][0-9]*)\/why$/.exec(pathname);
    if (method === "GET" && whyMatch) {
      const runId = Number(whyMatch[1]);
      const facts = hub.why(runId);
      const formatted = formatWhy(runId, facts as any);
      sendJson(res, { id: runId, formatted, facts });
      return true;
    }

    const cancelMatch = /^\/api\/console\/runs\/([1-9][0-9]*)\/cancel$/.exec(pathname);
    if (method === "POST" && cancelMatch) {
      const runId = Number(cancelMatch[1]);
      hub.execute("cancel", [runId], Date.now());
      sendJson(res, { ok: true });
      return true;
    }

    const cardAnswerMatch = /^\/api\/console\/cards\/([1-9][0-9]*)\/answer$/.exec(pathname);
    if (method === "POST" && cardAnswerMatch) {
      const cardId = Number(cardAnswerMatch[1]);
      const body = JSON.parse((await readBody(req)) || "{}");
      const payload: Record<string, unknown> = { by: "本人" };
      if (typeof body.choice === "number" && Number.isInteger(body.choice)) {
        payload.choice = body.choice;
      }
      if (typeof body.text === "string" && body.text.trim()) {
        payload.text = body.text.trim();
      }
      const result = hub.execute("answer", [cardId, payload], Date.now());
      sendJson(res, result);
      return true;
    }

    const cardResolveMatch = /^\/api\/console\/cards\/([1-9][0-9]*)\/resolve$/.exec(pathname);
    if (method === "POST" && cardResolveMatch) {
      const cardId = Number(cardResolveMatch[1]);
      const body = JSON.parse((await readBody(req)) || "{}");
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (!reason) {
        sendJson(res, { error: "请填写结案原因" }, 400);
        return true;
      }
      const changed = hub.execute("resolve", [cardId, reason, "本人"], Date.now());
      sendJson(res, { changed });
      return true;
    }

    if (method === "POST" && pathname === "/api/console/emit") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const source = typeof body.source === "string" && body.source.trim() ? body.source.trim() : "local";
      const type = typeof body.type === "string" && body.type.trim() ? body.type.trim() : "";
      if (!type) {
        sendJson(res, { error: "事件类型（type）不能为空" }, 400);
        return true;
      }
      const event = {
        id:
          typeof body.id === "string" && body.id.trim()
            ? body.id.trim()
            : `evt-${Date.now()}-${randomUUID().slice(0, 6)}`,
        type,
        ...(typeof body.subject === "string" && body.subject.trim() && { subject: body.subject.trim() }),
        ...(typeof body.summary === "string" && body.summary.trim() && { summary: body.summary.trim() }),
        ...(typeof body.detail === "string" && body.detail.trim() && { detail: body.detail.trim() }),
        ...(typeof body.link === "string" && body.link.trim() && { link: body.link.trim() }),
      };
      const result = hub.execute("ingest", [source, event], Date.now());
      sendJson(res, { ...result, event });
      return true;
    }

    if (method === "POST" && pathname === "/api/console/preview") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const activeFile = activeRulesPath();
      const rulesRaw =
        typeof body.rulesRaw === "string" && body.rulesRaw.trim() ? body.rulesRaw : readFileSync(activeFile, "utf8");
      const source = typeof body.source === "string" && body.source.trim() ? body.source.trim() : "local";
      const event = {
        id: "preview-id",
        type: typeof body.type === "string" && body.type.trim() ? body.type.trim() : "try.start",
        ...(typeof body.subject === "string" && body.subject.trim() && { subject: body.subject.trim() }),
        ...(typeof body.summary === "string" && body.summary.trim() && { summary: body.summary.trim() }),
        ...(typeof body.detail === "string" && body.detail.trim() && { detail: body.detail.trim() }),
      };
      const lines = previewEvent(rulesRaw, source, event, Date.now());
      sendJson(res, { lines });
      return true;
    }

    if (method === "POST" && pathname === "/api/console/rules/validate") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const raw = typeof body.rules === "string" ? body.rules : "";
      const parsed = hub.parseRules(raw, Date.now());
      const explain = explainRules(raw, Date.now());
      sendJson(res, { ok: true, parsed, explain });
      return true;
    }

    if (method === "PUT" && pathname === "/api/console/rules") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const raw = typeof body.rules === "string" ? body.rules : "";
      hub.parseRules(raw, Date.now());
      const formatted = `${JSON.stringify(JSON.parse(raw), null, 2)}\n`;
      const activeFile = activeRulesPath();
      writeFileSync(`${activeFile}.tmp`, formatted, { mode: 0o600 });
      renameSync(`${activeFile}.tmp`, activeFile);
      const reloadResult = hub.reloadRules(activeFile);
      if (reloadResult.problem) {
        sendJson(res, { error: reloadResult.problem }, 400);
        return true;
      }
      const explain = explainRules(formatted, Date.now());
      sendJson(res, { ok: true, rulesRaw: formatted, explain });
      return true;
    }

    if (method === "GET" && pathname === "/api/console/logs") {
      const after = Math.max(0, Number(reqUrl.searchParams.get("after") ?? "0") || 0);
      const limit = Math.min(500, Math.max(1, Number(reqUrl.searchParams.get("limit") ?? "120") || 120));
      const order = reqUrl.searchParams.get("order") === "asc" ? "ASC" : "DESC";
      const rows =
        order === "DESC"
          ? hub
              .all<{ seq: number; fact: string }>(
                "SELECT seq, fact FROM facts WHERE seq > ? ORDER BY seq DESC LIMIT ?",
                [after, limit],
              )
              .map((row) => JSON.parse(String(row.fact)))
          : hub.logAfter(after, limit);
      const totalRow = hub.one<{ total: number; maxSeq: number }>(
        "SELECT COUNT(*) AS total, COALESCE(MAX(seq), 0) AS maxSeq FROM facts",
      );
      sendJson(res, {
        facts: rows,
        total: totalRow?.total ?? 0,
        maxSeq: totalRow?.maxSeq ?? 0,
      });
      return true;
    }

    if (method === "POST" && pathname === "/api/console/keys") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const kind = body.kind;
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!["source", "worker", "channel", "owner"].includes(kind) || !name) {
        sendJson(res, { error: "请选择有效的密钥类型并填写名称" }, 400);
        return true;
      }
      const secret = hub.addKey(kind, name, Date.now());
      sendJson(res, { ok: true, kind, name, secret, keys: hub.listKeys() });
      return true;
    }

    const keyDeleteMatch = /^\/api\/console\/keys\/(source|worker|channel|owner)\/([^/]+)$/.exec(pathname);
    if (method === "DELETE" && keyDeleteMatch) {
      const kind = keyDeleteMatch[1];
      const name = decodeURIComponent(keyDeleteMatch[2]);
      const changed = hub.execute("removeKey", [kind, name], Date.now());
      sendJson(res, { ok: true, changed, keys: hub.listKeys() });
      return true;
    }

    if (method === "POST" && pathname === "/api/console/demo") {
      const now = Date.now();
      const firstRule = hub.rules.rules[0];
      const source =
        firstRule && "source" in firstRule.when
          ? firstRule.when.source
          : (Object.keys(hub.rules.sources)[0] ?? "local");
      const rawType = firstRule && "types" in firstRule.when ? firstRule.when.types[0] : "try.start";
      const type = rawType.replace("*", "demo");
      const ingestResult = hub.execute(
        "ingest",
        [
          source,
          {
            id: `sim-${now}-${randomUUID().slice(0, 4)}`,
            type,
            subject: `#${Math.floor((now / 1000) % 10000)}`,
            summary: "自动化巡检与回归验证：控制台触发的模拟业务事件，包含完整执行与 Token 计量",
            detail: "验证规则匹配、派单、会话续接、Token 统计与因果时间线查询。",
          },
        ],
        now,
      );
      const workerName = Object.values<any>(hub.rules.agents)[0]?.worker ?? "this-machine";
      const claimed = hub.execute("claimNext", [workerName, `sim-claim-${now}`], now + 10);
      if (claimed) {
        const sessionId = `sess-${now.toString(36)}`;
        hub.execute("started", [claimed.run, claimed.token, { session: sessionId }], now + 20);
        const inputTokens = 6800 + Math.floor(Math.random() * 9000);
        const outputTokens = 950 + Math.floor(Math.random() * 1400);
        const cost = Number((inputTokens * 0.000003 + outputTokens * 0.000015).toFixed(4));
        hub.execute(
          "finish",
          [
            claimed.run,
            claimed.token,
            {
              outcome: "done",
              summary: `自动巡检完成：检查 12 项核心指标均正常，本轮消耗 ${inputTokens + outputTokens} Token`,
              session: sessionId,
              usage: { input: inputTokens, output: outputTokens, cached: 2400, cost },
            },
          ],
          now + 120,
        );
      }
      sendJson(res, { ok: true, routed: ingestResult.routed, run: claimed?.run ?? null });
      return true;
    }

    sendJson(res, { error: "没有这个控制台接口" }, 404);
    return true;
  } catch (error) {
    sendJson(
      res,
      { error: (error as Error).message ?? String(error) },
      (error as any)?.name === "NotFound" ? 404 : 400,
    );
    return true;
  }
}

const CONSOLE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agent Autoloop — 自动化中台控制台</title>
  <meta name="description" content="Agent 自动化中台可视化控制台：配置规则、查看流程拓扑、监控 Token 消耗与费用、检索事实日志与因果时间线。" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Plus+Jakarta+Sans:wght@500;600;700&family=Public+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg-canvas: #f8fafc;
      --bg-surface: #ffffff;
      --bg-subtle: #f1f5f9;
      --bg-active: #e2e8f0;
      --text-primary: #0f172a;
      --text-secondary: #475569;
      --text-muted: #64748b;
      --border-hairline: #e2e8f0;
      --border-strong: #cbd5e1;
      --accent: #0f172a;
      --accent-fg: #ffffff;
      --accent-blue: #2563eb;
      --accent-blue-soft: rgba(37, 99, 235, 0.08);
      --status-ok: #16a34a;
      --status-warn: #d97706;
      --status-err: #dc2626;
      --font-display: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
      --font-body: 'Public Sans', -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
      --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }

    html.dark {
      --bg-canvas: #0b1120;
      --bg-surface: #111827;
      --bg-subtle: #1e293b;
      --bg-active: #334155;
      --text-primary: #f8fafc;
      --text-secondary: #cbd5e1;
      --text-muted: #94a3b8;
      --border-hairline: #1e293b;
      --border-strong: #334155;
      --accent: #f8fafc;
      --accent-fg: #0f172a;
      --accent-blue: #3b82f6;
      --accent-blue-soft: rgba(59, 130, 246, 0.14);
      --status-ok: #22c55e;
      --status-warn: #f59e0b;
      --status-err: #ef4444;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--font-body);
      background-color: var(--bg-canvas);
      color: var(--text-primary);
      font-size: 14px;
      line-height: 1.55;
      -webkit-font-smoothing: antialiased;
      min-height: 100vh;
    }

    .tabular, code, pre, .mono {
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
    }

    /* 3-Zone Top Bar Contract */
    .topbar {
      position: sticky;
      top: 0;
      z-index: 30;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 32px;
      height: 60px;
      padding: 0 28px;
      background-color: var(--bg-surface);
      border-bottom: 1px solid var(--border-hairline);
    }

    .brand-wordmark {
      font-family: var(--font-display);
      font-size: 16px;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--text-primary);
      text-decoration: none;
      white-space: nowrap;
      flex-shrink: 0;
      cursor: pointer;
    }

    .topnav {
      display: flex;
      align-items: center;
      gap: 24px;
      overflow-x: auto;
    }

    .topnav-link {
      background: none;
      border: none;
      font-family: var(--font-display);
      font-size: 13.5px;
      font-weight: 600;
      color: var(--text-secondary);
      cursor: pointer;
      padding: 18px 2px;
      border-bottom: 2px solid transparent;
      white-space: nowrap;
      flex-shrink: 0;
      transition: color 140ms ease, border-color 140ms ease;
    }

    .topnav-link:hover {
      color: var(--text-primary);
    }

    .topnav-link.active {
      color: var(--text-primary);
      border-bottom-color: var(--accent-blue);
    }

    /* Buttons */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      min-height: 36px;
      padding: 6px 14px;
      font-family: var(--font-display);
      font-size: 13px;
      font-weight: 600;
      border-radius: 6px;
      border: 1px solid var(--border-strong);
      background-color: var(--bg-surface);
      color: var(--text-primary);
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
      transition: opacity 140ms ease, transform 140ms ease, background-color 140ms ease;
    }

    .btn:hover {
      background-color: var(--bg-subtle);
    }

    .btn:active {
      transform: translateY(1px);
    }

    .btn-primary {
      background-color: var(--accent);
      color: var(--accent-fg);
      border-color: var(--accent);
    }

    .btn-primary:hover {
      background-color: var(--accent);
      opacity: 0.9;
    }

    .btn-blue {
      background-color: var(--accent-blue);
      color: #ffffff;
      border-color: var(--accent-blue);
    }

    .btn-blue:hover {
      background-color: var(--accent-blue);
      opacity: 0.92;
    }

    .btn-danger {
      color: var(--status-err);
      border-color: var(--border-strong);
    }

    .btn-sm {
      min-height: 30px;
      padding: 4px 10px;
      font-size: 12px;
    }

    /* Main Container */
    .workspace {
      max-width: 1400px;
      margin: 0 auto;
      padding: 24px 28px 64px;
    }

    /* Sub-toolbar below header */
    .subbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding-bottom: 20px;
      margin-bottom: 24px;
      border-bottom: 1px solid var(--border-hairline);
    }

    .meta-line {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      font-size: 12.5px;
      color: var(--text-muted);
    }

    .toolbar-actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    /* KPI Strip */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 28px;
    }

    .surface-box {
      background-color: var(--bg-surface);
      border: 1px solid var(--border-hairline);
      border-radius: 8px;
      padding: 20px;
    }

    .kpi-label {
      font-size: 12.5px;
      color: var(--text-muted);
      margin-bottom: 6px;
    }

    .kpi-value {
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
      font-size: 26px;
      font-weight: 600;
      color: var(--text-primary);
      line-height: 1.2;
      margin-bottom: 6px;
    }

    .kpi-sub {
      font-size: 12px;
      color: var(--text-secondary);
    }

    /* Section Headers */
    .section-block {
      margin-bottom: 32px;
    }

    .section-head {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 14px;
    }

    .section-title {
      font-family: var(--font-display);
      font-size: 17px;
      font-weight: 600;
      color: var(--text-primary);
      text-wrap: balance;
    }

    .section-desc {
      font-size: 13px;
      color: var(--text-muted);
    }

    /* Segmented Filter Controls */
    .segmented {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 3px;
      background-color: var(--bg-subtle);
      border-radius: 7px;
      border: 1px solid var(--border-hairline);
    }

    .seg-btn {
      border: none;
      background: transparent;
      color: var(--text-secondary);
      font-family: var(--font-display);
      font-size: 12.5px;
      font-weight: 500;
      padding: 5px 11px;
      border-radius: 5px;
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .seg-btn.active {
      background-color: var(--bg-surface);
      color: var(--text-primary);
      font-weight: 600;
    }

    /* Tables */
    .table-wrap {
      background-color: var(--bg-surface);
      border: 1px solid var(--border-hairline);
      border-radius: 8px;
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
    }

    th {
      font-family: var(--font-display);
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      padding: 11px 16px;
      border-bottom: 1px solid var(--border-hairline);
      background-color: var(--bg-subtle);
      white-space: nowrap;
    }

    td {
      padding: 11px 16px;
      border-bottom: 1px solid var(--border-hairline);
      font-size: 13.5px;
      color: var(--text-primary);
      vertical-align: top;
    }

    tr:last-child td {
      border-bottom: none;
    }

    tbody tr:hover {
      background-color: var(--bg-subtle);
    }

    .num-col {
      text-align: right;
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    /* Pipeline Grid */
    .pipeline-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(220px, 1fr));
      gap: 16px;
      overflow-x: auto;
    }

    .pipeline-col {
      background-color: var(--bg-surface);
      border: 1px solid var(--border-hairline);
      border-radius: 8px;
      padding: 16px;
    }

    .pipeline-col-title {
      font-family: var(--font-display);
      font-size: 13px;
      font-weight: 600;
      color: var(--text-secondary);
      padding-bottom: 10px;
      margin-bottom: 12px;
      border-bottom: 1px solid var(--border-hairline);
    }

    .pipeline-item {
      padding: 10px 0;
      border-bottom: 1px solid var(--border-hairline);
    }

    .pipeline-item:last-child {
      border-bottom: none;
      padding-bottom: 0;
    }

    .pipeline-item-name {
      font-weight: 600;
      font-size: 13.5px;
      color: var(--text-primary);
      margin-bottom: 2px;
    }

    /* Decision Cards */
    .decision-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
      gap: 16px;
    }

    .decision-card {
      background-color: var(--bg-surface);
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      padding: 20px;
    }

    .decision-title {
      font-family: var(--font-display);
      font-size: 16px;
      font-weight: 600;
      margin: 6px 0 8px;
      color: var(--text-primary);
    }

    .decision-text {
      font-size: 13.5px;
      color: var(--text-secondary);
      white-space: pre-wrap;
      margin-bottom: 16px;
    }

    .option-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 12px;
    }

    /* Forms & Inputs */
    .input, .select, .textarea {
      width: 100%;
      font-family: var(--font-body);
      font-size: 13.5px;
      color: var(--text-primary);
      background-color: var(--bg-surface);
      border: 1px solid var(--border-strong);
      border-radius: 6px;
      padding: 8px 12px;
      outline: none;
    }

    .input:focus, .select:focus, .textarea:focus {
      border-color: var(--accent-blue);
    }

    .textarea-code {
      font-family: var(--font-mono);
      font-size: 13px;
      line-height: 1.6;
      min-height: 400px;
      resize: vertical;
    }

    .filter-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 14px;
    }

    /* Status Text Colors (always paired with explicit words) */
    .status-ok { color: var(--status-ok); font-weight: 600; }
    .status-warn { color: var(--status-warn); font-weight: 600; }
    .status-err { color: var(--status-err); font-weight: 600; }
    .status-muted { color: var(--text-muted); }

    /* Progress bar for token share */
    .bar-track {
      width: 100%;
      height: 6px;
      background-color: var(--bg-subtle);
      border-radius: 3px;
      overflow: hidden;
      margin-top: 6px;
    }

    .bar-fill {
      height: 100%;
      background-color: var(--accent-blue);
    }

    /* Drawer / Modal */
    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 50;
      background-color: rgba(15, 23, 42, 0.55);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }

    .backdrop.open {
      display: flex;
    }

    .modal-panel {
      background-color: var(--bg-surface);
      border: 1px solid var(--border-strong);
      border-radius: 10px;
      width: 100%;
      max-width: 780px;
      max-height: 88vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .modal-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 22px;
      border-bottom: 1px solid var(--border-hairline);
    }

    .modal-body {
      padding: 22px;
      overflow-y: auto;
    }

    .pre-box {
      background-color: var(--bg-subtle);
      border: 1px solid var(--border-hairline);
      border-radius: 6px;
      padding: 14px;
      font-family: var(--font-mono);
      font-size: 12.5px;
      line-height: 1.6;
      white-space: pre-wrap;
      overflow-x: auto;
      color: var(--text-primary);
    }

    .two-col {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
    }

    .form-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 12px;
      margin-bottom: 14px;
    }

    .field-label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-secondary);
      margin-bottom: 5px;
    }

    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 60;
      background-color: var(--text-primary);
      color: var(--bg-surface);
      padding: 10px 16px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      display: none;
    }

    .toast.show {
      display: block;
    }

    .hidden {
      display: none !important;
    }

    @media (max-width: 960px) {
      .two-col {
        grid-template-columns: 1fr;
      }
      .pipeline-grid {
        grid-template-columns: 1fr 1fr;
      }
      .decision-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <!-- 3-Zone Top Bar Contract -->
  <header class="topbar">
    <a class="brand-wordmark" onclick="switchTab('overview')">Agent Autoloop</a>

    <nav class="topnav" aria-label="主导航">
      <button class="topnav-link active" data-tab="overview" onclick="switchTab('overview')">01. 总览与待办</button>
      <button class="topnav-link" data-tab="runs" onclick="switchTab('runs')">02. 流程与结果查询</button>
      <button class="topnav-link" data-tab="tokens" onclick="switchTab('tokens')">03. Token 与费用</button>
      <button class="topnav-link" data-tab="config" onclick="switchTab('config')">04. 规则与密钥配置</button>
      <button class="topnav-link" data-tab="logs" onclick="switchTab('logs')">05. 事实日志与监控</button>
    </nav>

    <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
      <button class="btn btn-primary" onclick="openEmitModal()">发送事件 / 预演</button>
    </div>
  </header>

  <main class="workspace">
    <!-- Contextual Workspace Toolbar -->
    <div class="subbar">
      <div class="meta-line" id="workspace-meta">
        <span>正在同步中台状态…</span>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-sm" onclick="triggerDemoRun()">模拟触发一轮完整流程</button>
        <button class="btn btn-sm" onclick="refreshAll()">立即刷新</button>
        <button class="btn btn-sm" id="theme-btn" onclick="toggleTheme()">切换深色</button>
      </div>
    </div>

    <!-- VIEW 1: 总览与待办 -->
    <section id="view-overview">
      <div class="kpi-grid" id="overview-kpis"></div>

      <!-- 待拍板 / 待留意卡片 -->
      <div class="section-block">
        <div class="section-head">
          <div>
            <h2 class="section-title">待你拍板与留意的卡片</h2>
            <p class="section-desc">Agent 遇到需要人类判断的事项已结束当轮进程（不占进程、不耗 Token），你拍板后中台自动唤醒它在原会话继续执行</p>
          </div>
        </div>
        <div id="open-cards-container"></div>
      </div>

      <!-- 流程管线拓扑 -->
      <div class="section-block">
        <div class="section-head">
          <div>
            <h2 class="section-title">自动化流程拓扑（只收 · 只分 · 只派 · 只记）</h2>
            <p class="section-desc">点击任意规则可直接筛选对应的执行轮次与结果</p>
          </div>
          <button class="btn btn-sm" onclick="switchTab('config')">编辑分派规则</button>
        </div>
        <div class="pipeline-grid" id="pipeline-container"></div>
      </div>

      <!-- 最近执行轮次简表 -->
      <div class="section-block">
        <div class="section-head">
          <div>
            <h2 class="section-title">最新执行动态</h2>
            <p class="section-desc">展示最近 8 轮派单执行结果与单轮 Token 消耗</p>
          </div>
          <button class="btn btn-sm" onclick="switchTab('runs')">查看全部轮次与查询</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>轮次</th>
                <th>规则名称</th>
                <th>接单 Agent</th>
                <th>当前状态</th>
                <th>触发事件 / 对象</th>
                <th>结论摘要 / 错误</th>
                <th class="num-col">Token 消耗</th>
                <th class="num-col">费用</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody id="overview-runs-tbody"></tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- VIEW 2: 流程与结果查询 -->
    <section id="view-runs" class="hidden">
      <div class="section-block">
        <div class="section-head">
          <div>
            <h2 class="section-title">执行轮次与结果检索</h2>
            <p class="section-desc">支持按状态、规则名、事件主题、执行结论检索，并可点击「因果时间线」还原每一轮的完整事实链（why）</p>
          </div>
        </div>

        <div class="filter-bar">
          <div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px;flex:1;">
            <input type="search" id="runs-search" class="input" style="max-width:300px;" placeholder="搜索轮次 #ID、规则、事件、结论或错误…" oninput="renderRunsView()" />
            <select id="runs-rule-filter" class="select" style="max-width:200px;" onchange="renderRunsView()">
              <option value="">全部规则</option>
            </select>
          </div>
          <div class="segmented" id="runs-state-seg">
            <button class="seg-btn active" data-state="all" onclick="setRunStateFilter('all')">全部</button>
            <button class="seg-btn" data-state="claimed" onclick="setRunStateFilter('claimed')">在跑</button>
            <button class="seg-btn" data-state="queued" onclick="setRunStateFilter('queued')">排队 / 待重派</button>
            <button class="seg-btn" data-state="done" onclick="setRunStateFilter('done')">已完成</button>
            <button class="seg-btn" data-state="nothing" onclick="setRunStateFilter('nothing')">没事可做</button>
            <button class="seg-btn" data-state="cancelled" onclick="setRunStateFilter('cancelled')">已停止</button>
          </div>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>轮次</th>
                <th>规则名称</th>
                <th>Agent</th>
                <th>状态</th>
                <th>触发事件</th>
                <th>执行结论 / 错误原因</th>
                <th class="num-col">输入 Token</th>
                <th class="num-col">输出 Token</th>
                <th class="num-col">费用</th>
                <th>会话 / 时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody id="runs-full-tbody"></tbody>
          </table>
        </div>
      </div>

      <div class="two-col">
        <div class="section-block">
          <div class="section-head">
            <div>
              <h2 class="section-title">最近已拍板 / 结案卡片</h2>
              <p class="section-desc">历史提问回答与通知处理记录</p>
            </div>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>编号</th>
                  <th>标题</th>
                  <th>你的决定 / 结案结果</th>
                  <th>所属规则</th>
                </tr>
              </thead>
              <tbody id="recent-cards-tbody"></tbody>
            </table>
          </div>
        </div>

        <div class="section-block">
          <div class="section-head">
            <div>
              <h2 class="section-title">没有规则接的事件（Unrouted）</h2>
              <p class="section-desc">已记入事实日志但未匹配任何规则的外部事件</p>
            </div>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>来源</th>
                  <th>事件类型</th>
                  <th>主题与摘要</th>
                  <th>接收时间</th>
                </tr>
              </thead>
              <tbody id="unrouted-tbody"></tbody>
            </table>
          </div>
        </div>
      </div>
    </section>

    <!-- VIEW 3: Token 与费用 -->
    <section id="view-tokens" class="hidden">
      <div class="kpi-grid" id="token-kpis"></div>

      <div class="two-col">
        <div class="section-block">
          <div class="section-head">
            <div>
              <h2 class="section-title">按分派规则统计消耗</h2>
              <p class="section-desc">各业务规则累计执行的轮次数、输入/输出 Token 与费用</p>
            </div>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>规则名称</th>
                  <th>Agent</th>
                  <th class="num-col">完成轮数</th>
                  <th class="num-col">输入 Token</th>
                  <th class="num-col">输出 Token</th>
                  <th class="num-col">总 Token</th>
                  <th class="num-col">累计费用</th>
                </tr>
              </thead>
              <tbody id="tokens-by-rule-tbody"></tbody>
            </table>
          </div>
        </div>

        <div class="section-block">
          <div class="section-head">
            <div>
              <h2 class="section-title">按接单 Agent 统计消耗</h2>
              <p class="section-desc">各 Agent 实例与所在接单机器（worker）的资源消耗</p>
            </div>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>插件 / 机器</th>
                  <th>在线状态</th>
                  <th class="num-col">完成轮数</th>
                  <th class="num-col">总 Token</th>
                  <th class="num-col">累计费用</th>
                </tr>
              </thead>
              <tbody id="tokens-by-agent-tbody"></tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="section-block">
        <div class="section-head">
          <div>
            <h2 class="section-title">单轮 Token 与费用台账明细</h2>
            <p class="section-desc">按轮次展示上报了 Usage 的详细输入、输出、缓存命中与费用数据</p>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>轮次</th>
                <th>规则名称</th>
                <th>Agent</th>
                <th>完成时间</th>
                <th>结论摘要</th>
                <th class="num-col">输入 Token</th>
                <th class="num-col">输出 Token</th>
                <th class="num-col">总计 Token</th>
                <th class="num-col">本轮费用</th>
              </tr>
            </thead>
            <tbody id="tokens-ledger-tbody"></tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- VIEW 4: 规则与密钥配置 -->
    <section id="view-config" class="hidden">
      <div class="two-col">
        <!-- Left: Quick visual rule builder + Explain -->
        <div>
          <div class="section-block surface-box">
            <div class="section-head">
              <div>
                <h2 class="section-title">快速新增分派规则</h2>
                <p class="section-desc">填写表单自动追加到右侧 rules.json 编辑器，校验无误后保存即可热生效</p>
              </div>
            </div>
            <div class="form-grid">
              <div>
                <label class="field-label" for="qb-name">规则名称</label>
                <input id="qb-name" class="input" placeholder="例如：PR 自动审查" />
              </div>
              <div>
                <label class="field-label" for="qb-mode">触发方式</label>
                <select id="qb-mode" class="select" onchange="toggleQuickBuilderMode()">
                  <option value="event">事件驱动（when.source + types）</option>
                  <option value="cron">定时任务（when.cron）</option>
                </select>
              </div>
            </div>
            <div class="form-grid" id="qb-event-fields">
              <div>
                <label class="field-label" for="qb-source">事件来源 ID（source）</label>
                <input id="qb-source" class="input" value="local" placeholder="例如：local 或 github" />
              </div>
              <div>
                <label class="field-label" for="qb-types">匹配事件类型（逗号分隔）</label>
                <input id="qb-types" class="input" value="pr.opened, pr.synchronize" placeholder="例如：issue.*, pr.opened" />
              </div>
            </div>
            <div class="form-grid hidden" id="qb-cron-fields">
              <div>
                <label class="field-label" for="qb-cron">Cron 表达式（5 段）</label>
                <input id="qb-cron" class="input mono" value="0 9 * * 1-5" placeholder="例如：0 9 * * 1-5" />
              </div>
            </div>
            <div class="form-grid">
              <div>
                <label class="field-label" for="qb-agent">派给哪个 Agent（to）</label>
                <input id="qb-agent" class="input" value="agent" placeholder="Agent ID" />
              </div>
              <div>
                <label class="field-label" for="qb-cwd">工作目录（cwd）</label>
                <input id="qb-cwd" class="input mono" value="~/project" placeholder="例如：~/project" />
              </div>
            </div>
            <div style="margin-bottom:14px;">
              <label class="field-label" for="qb-prompt">任务指令（prompt，外部事件内容不进提示词，只靠此规则指令）</label>
              <textarea id="qb-prompt" class="textarea" rows="2" placeholder="阅读资料文件，按团队规范执行检查并在需要时通过回执提问。"></textarea>
            </div>
            <button class="btn btn-blue" onclick="appendRuleToEditor()">追加到右侧 rules.json 并保存</button>
          </div>

          <div class="section-block surface-box">
            <div class="section-head">
              <div>
                <h2 class="section-title">当前生效规则白话说明（rules explain）</h2>
                <p class="section-desc">按本机 rules.json 解析的时区、来源、Agent、通道与下次定时触发时间</p>
              </div>
            </div>
            <pre class="pre-box" id="config-explain-box">正在加载…</pre>
          </div>

          <!-- Keys Management -->
          <div class="section-block surface-box">
            <div class="section-head">
              <div>
                <h2 class="section-title">门禁密钥管理（Keys）</h2>
                <p class="section-desc">四道门各自独立验权：来源（source）、接单程序（worker）、通道（channel）、本人（owner）</p>
              </div>
            </div>

            <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;">
              <select id="new-key-kind" class="select" style="width:auto;">
                <option value="source">source（事件来源）</option>
                <option value="worker">worker（接单程序）</option>
                <option value="channel">channel（通知通道）</option>
                <option value="owner">owner（本人）</option>
              </select>
              <input id="new-key-name" class="input" style="max-width:180px;" placeholder="密钥名称，如 github" />
              <button class="btn btn-primary" onclick="createNewKey()">新建密钥</button>
            </div>

            <div id="created-secret-banner" class="pre-box hidden" style="margin-bottom:14px;border-color:var(--accent-blue);"></div>

            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>种类</th>
                    <th>名称</th>
                    <th>创建时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody id="keys-tbody"></tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- Right: rules.json full editor -->
        <div>
          <div class="section-block surface-box">
            <div class="section-head">
              <div>
                <h2 class="section-title">rules.json 配置文件编辑器</h2>
                <p class="section-desc" id="rules-file-path-label">支持实时语法与 Schema 校验，保存后中台自动热加载并记录新规则版本事实</p>
              </div>
              <div style="display:flex;gap:8px;">
                <button class="btn btn-sm" onclick="validateRulesEditor()">校验语法与规则</button>
                <button class="btn btn-sm btn-primary" onclick="saveRulesEditor()">保存并立即生效</button>
              </div>
            </div>
            <div id="rules-validation-msg" class="meta-line" style="margin-bottom:10px;"></div>
            <textarea id="rules-json-editor" class="textarea textarea-code" spellcheck="false"></textarea>
          </div>
        </div>
      </div>
    </section>

    <!-- VIEW 5: 事实日志与监控 -->
    <section id="view-logs" class="hidden">
      <!-- Health & Service Connections -->
      <div class="section-block">
        <div class="section-head">
          <div>
            <h2 class="section-title">核心服务连接与健康状态（/health）</h2>
            <p class="section-desc">实时监测 SQLite 持久事实库、规则引擎、中台调度器与接单 Worker 状态</p>
          </div>
          <a href="/health" target="_blank" rel="noopener" class="btn btn-sm">查看原始 /health JSON</a>
        </div>
        <div class="kpi-grid" id="health-cards-grid"></div>
      </div>

      <!-- Fact Log Explorer -->
      <div class="section-block">
        <div class="section-head">
          <div>
            <h2 class="section-title">权威事实日志流（Fact Log Explorer）</h2>
            <p class="section-desc">事实日志（facts 表）是唯一权威状态，所有视图与投影均由以下事实事务演化生成</p>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="meta-line" id="logs-count-label"></span>
            <button class="btn btn-sm" onclick="loadFactLogs()">刷新日志</button>
          </div>
        </div>

        <div class="filter-bar">
          <input type="search" id="logs-search" class="input" style="max-width:300px;" placeholder="搜索事实序号 #seq、类型、表名或内容…" oninput="renderFactLogsTable()" />
          <div class="segmented" id="logs-type-seg">
            <button class="seg-btn active" data-ftype="all" onclick="setFactTypeFilter('all')">全部事实</button>
            <button class="seg-btn" data-ftype="ingest" onclick="setFactTypeFilter('ingest')">ingest（收事件）</button>
            <button class="seg-btn" data-ftype="claimNext" onclick="setFactTypeFilter('claimNext')">claimNext（派单）</button>
            <button class="seg-btn" data-ftype="finish" onclick="setFactTypeFilter('finish')">finish（结轮回执）</button>
            <button class="seg-btn" data-ftype="answer" onclick="setFactTypeFilter('answer')">answer（回答卡片）</button>
            <button class="seg-btn" data-ftype="rules" onclick="setFactTypeFilter('rules')">rules（规则变更）</button>
          </div>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>序号 (#seq)</th>
                <th>事实类型 (type)</th>
                <th>发生时间 (at)</th>
                <th>变更投影表 (changes)</th>
                <th>核心变更摘要</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody id="fact-logs-tbody"></tbody>
          </table>
        </div>
      </div>
    </section>
  </main>

  <!-- MODAL 1: Run Why Timeline & Fact Inspector -->
  <div class="backdrop" id="why-modal" onclick="if(event.target===this)closeWhyModal()">
    <div class="modal-panel">
      <div class="modal-head">
        <h3 class="section-title" id="why-modal-title">因果时间线（why）</h3>
        <button class="btn btn-sm" onclick="closeWhyModal()">关闭</button>
      </div>
      <div class="modal-body">
        <p class="field-label">时间线还原（触发事件 → 领取 → 会话 → 提问/回答 → 结论）</p>
        <pre class="pre-box" id="why-formatted-box" style="margin-bottom:18px;"></pre>
        <p class="field-label">关联的原始事实记录（Safe Facts JSON）</p>
        <pre class="pre-box" id="why-facts-box"></pre>
      </div>
    </div>
  </div>

  <!-- MODAL 2: Emit Event / Dry-Run Preview -->
  <div class="backdrop" id="emit-modal" onclick="if(event.target===this)closeEmitModal()">
    <div class="modal-panel" style="max-width:600px;">
      <div class="modal-head">
        <h3 class="section-title">发送事件 / 规则路由预演</h3>
        <button class="btn btn-sm" onclick="closeEmitModal()">关闭</button>
      </div>
      <div class="modal-body">
        <div class="form-grid">
          <div>
            <label class="field-label" for="emit-source">事件来源（source）</label>
            <select id="emit-source" class="select"></select>
          </div>
          <div>
            <label class="field-label" for="emit-type">事件类型（type）</label>
            <input id="emit-type" class="input mono" value="try.start" placeholder="例如：try.start 或 issue.opened" />
          </div>
        </div>
        <div style="margin-bottom:12px;">
          <label class="field-label" for="emit-subject">事件对象标识（subject，仅限英文/数字/#._:/@-）</label>
          <input id="emit-subject" class="input mono" value="#108" placeholder="例如：#108 或 pr:42" />
        </div>
        <div style="margin-bottom:12px;">
          <label class="field-label" for="emit-summary">摘要说明（summary）</label>
          <input id="emit-summary" class="input" value="验证新流程分派：从可视化控制台发起的事件" placeholder="一句话说明事件概况" />
        </div>
        <div style="margin-bottom:16px;">
          <label class="field-label" for="emit-detail">详细资料（detail，仅作资料文件供 Agent 读取，不拼接进 Prompt）</label>
          <textarea id="emit-detail" class="textarea" rows="3" placeholder="附加的上下文日志或业务数据…"></textarea>
        </div>

        <div id="emit-preview-output" class="pre-box hidden" style="margin-bottom:16px;"></div>

        <div style="display:flex;justify-content:flex-end;gap:10px;">
          <button class="btn" onclick="runEmitPreview()">仅预演路由（--dry-run）</button>
          <button class="btn btn-primary" onclick="submitEmitEvent()">正式发送事件</button>
        </div>
      </div>
    </div>
  </div>

  <!-- MODAL 3: Single Fact JSON Inspector -->
  <div class="backdrop" id="fact-modal" onclick="if(event.target===this)closeFactModal()">
    <div class="modal-panel">
      <div class="modal-head">
        <h3 class="section-title" id="fact-modal-title">事实详情</h3>
        <button class="btn btn-sm" onclick="closeFactModal()">关闭</button>
      </div>
      <div class="modal-body">
        <pre class="pre-box" id="fact-modal-box"></pre>
      </div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    let appData = null;
    let factLogs = [];
    let currentTab = 'overview';
    let runStateFilter = 'all';
    let factTypeFilter = 'all';
    let editorDirty = false;

    const STATE_LABELS = {
      claimed: { text: '在跑', cls: 'status-ok' },
      queued: { text: '排队', cls: 'status-warn' },
      done: { text: '做完了', cls: 'status-ok' },
      nothing: { text: '没事可做', cls: 'status-muted' },
      unknown: { text: '不确定', cls: 'status-warn' },
      cancelled: { text: '已停止', cls: 'status-err' },
    };

    function esc(str) {
      return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function fmtNum(n) {
      return Number(n || 0).toLocaleString('zh-CN');
    }

    function fmtCost(amount) {
      const n = Number(amount || 0);
      if (n === 0) return '$0.00';
      if (n > 0 && n < 0.01) return '<$0.01 ($' + n.toFixed(4) + ')';
      return '$' + n.toFixed(4);
    }

    function fmtTime(iso) {
      if (!iso) return '—';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso);
      return d.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
      });
    }

    function showToast(msg) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.classList.add('show');
      clearTimeout(window.__toastTimer);
      window.__toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
    }

    function toggleTheme() {
      const isDark = document.documentElement.classList.toggle('dark');
      localStorage.setItem('autoloop_theme', isDark ? 'dark' : 'light');
      document.getElementById('theme-btn').textContent = isDark ? '切换浅色' : '切换深色';
    }

    (function initTheme() {
      const saved = localStorage.getItem('autoloop_theme');
      if (saved === 'dark') {
        document.documentElement.classList.add('dark');
        document.addEventListener('DOMContentLoaded', () => {
          const btn = document.getElementById('theme-btn');
          if (btn) btn.textContent = '切换浅色';
        });
      }
    })();

    function switchTab(tab) {
      currentTab = tab;
      document.querySelectorAll('.topnav-link').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
      });
      ['overview', 'runs', 'tokens', 'config', 'logs'].forEach((id) => {
        const sec = document.getElementById('view-' + id);
        if (sec) sec.classList.toggle('hidden', id !== tab);
      });
      if (tab === 'logs') loadFactLogs();
    }

    async function refreshAll() {
      try {
        const res = await fetch('/api/console/overview');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        appData = await res.json();
        renderWorkspaceMeta();
        renderOverview();
        renderRunsView();
        renderTokensView();
        renderConfigView();
        renderHealthCards();
        if (currentTab === 'logs') await loadFactLogs();
      } catch (err) {
        showToast('同步状态失败：' + err.message);
      }
    }

    function renderWorkspaceMeta() {
      if (!appData) return;
      const { health, state, spendSummary } = appData;
      const healthText = health.ok ? '<span class="status-ok">核心服务正常</span>' : '<span class="status-err">服务降级</span>';
      document.getElementById('workspace-meta').innerHTML =
        healthText +
        '<span>·</span>' +
        '<span>时区 <strong class="mono">' + esc(state.timezone) + '</strong></span>' +
        '<span>·</span>' +
        '<span>提交 <strong class="mono">' + esc(String(health.commit).slice(0, 12)) + '</strong></span>' +
        '<span>·</span>' +
        '<span class="mono">' + esc(spendSummary) + '</span>';
    }

    function renderOverview() {
      if (!appData) return;
      const { state } = appData;
      const t = state.totals;
      const sp = state.spending;

      document.getElementById('overview-kpis').innerHTML = [
        {
          label: '当前在跑 / 排队轮次',
          val: fmtNum(t.running) + ' / ' + fmtNum(t.queued),
          sub: '今日已完成 ' + fmtNum(t.doneToday) + ' 轮 · 累计完成 ' + fmtNum(t.done) + ' 轮',
        },
        {
          label: '待你拍板卡片',
          val: fmtNum(state.cards.length),
          sub: state.cards.length ? '回答后自动唤醒对应 Agent 续跑' : '当前无阻塞等待事项',
        },
        {
          label: '今日 Token 消耗',
          val: fmtNum(sp.today.tokens),
          sub: '今日 ' + fmtNum(sp.today.rounds) + ' 轮 · 费用 ' + fmtCost(sp.today.cost),
        },
        {
          label: '最近 7 天 Token 消耗',
          val: fmtNum(sp.week.tokens),
          sub: '近 7 天 ' + fmtNum(sp.week.rounds) + ' 轮 · 费用 ' + fmtCost(sp.week.cost),
        },
      ]
        .map(
          (k) =>
            '<div class="surface-box">' +
            '<div class="kpi-label">' + esc(k.label) + '</div>' +
            '<div class="kpi-value">' + esc(k.val) + '</div>' +
            '<div class="kpi-sub">' + esc(k.sub) + '</div>' +
            '</div>'
        )
        .join('');

      // Open Decision Cards
      const cardsEl = document.getElementById('open-cards-container');
      if (!state.cards.length) {
        cardsEl.innerHTML =
          '<div class="surface-box" style="display:flex;align-items:center;justify-content:space-between;gap:16px;">' +
          '<div>' +
          '<div style="font-weight:600;margin-bottom:4px;">当前没有等待你拍板的卡片</div>' +
          '<div class="section-desc">当 Agent 在规则执行中需要你做选择或留意异常时，卡片会实时出现在这里。</div>' +
          '</div>' +
          '<button class="btn btn-sm" onclick="openEmitModal()">发一条事件试试</button>' +
          '</div>';
      } else {
        cardsEl.innerHTML =
          '<div class="decision-grid">' +
          state.cards
            .map((c) => {
              const kindLabel = c.kind === 'ask' ? '<span class="status-warn">等你决定 (ask)</span>' : '<span class="status-ok">要你留意 (notice)</span>';
              const optionsHtml =
                c.kind === 'ask'
                  ? '<div class="option-row">' +
                    (c.options || [])
                      .map(
                        (opt, idx) =>
                          '<button class="btn ' +
                          (idx === c.recommend ? 'btn-primary' : '') +
                          '" onclick="answerCard(' +
                          c.id +
                          ',' +
                          idx +
                          ')">' +
                          (idx + 1) +
                          '. ' +
                          esc(opt) +
                          (idx === c.recommend ? '（推荐）' : '') +
                          '</button>'
                      )
                      .join('') +
                    '</div>'
                  : '';

              return (
                '<div class="decision-card">' +
                '<div class="meta-line">' +
                kindLabel +
                '<span>·</span>' +
                '<span class="mono">卡片 #' + c.id + '</span>' +
                (c.rule ? '<span>·</span><span>规则：' + esc(c.rule) + '</span>' : '') +
                '<span>·</span>' +
                '<span class="mono">' + fmtTime(c.createdAt) + '</span>' +
                '</div>' +
                '<div class="decision-title">' + esc(c.title) + '</div>' +
                (c.text ? '<div class="decision-text">' + esc(c.text) + '</div>' : '') +
                optionsHtml +
                '<div style="display:flex;gap:8px;margin-top:8px;">' +
                '<input id="card-custom-' + c.id + '" class="input" placeholder="' +
                (c.kind === 'ask' ? '或者直接写别的想法…' : '填写处理说明（可不填直接结案）…') +
                '" />' +
                '<button class="btn" onclick="answerCardCustom(' + c.id + ', \\'' + c.kind + '\\')">' +
                (c.kind === 'ask' ? '按填写的回答' : '记录并结案') +
                '</button>' +
                '<button class="btn btn-sm" onclick="resolveCardPrompt(' + c.id + ')">直接结案</button>' +
                '</div>' +
                '</div>'
              );
            })
            .join('') +
          '</div>';
      }

      // Pipeline Topology
      const sourcesHtml =
        state.sources
          .map(
            (s) =>
              '<div class="pipeline-item">' +
              '<div class="pipeline-item-name">' + esc(s.name) + ' <span class="mono status-muted">(' + esc(s.id) + ')</span></div>' +
              '<div class="meta-line"><span class="mono">已收事件 ' + fmtNum(s.events) + ' 条</span></div>' +
              '</div>'
          )
          .join('') +
        state.lines
          .filter((l) => l.every)
          .map(
            (l) =>
              '<div class="pipeline-item">' +
              '<div class="pipeline-item-name">定时：' + esc(l.name) + '</div>' +
              '<div class="meta-line"><span>' + esc(l.every) + '</span><span>·</span><span class="mono">下次 ' + fmtTime(l.next) + '</span></div>' +
              '</div>'
          )
          .join('');

      const rulesHtml = state.lines
        .map(
          (r) =>
            '<div class="pipeline-item" style="cursor:pointer;" onclick="jumpToRuleRuns(\\'' + esc(r.name) + '\\')">' +
            '<div class="pipeline-item-name">' + esc(r.name) + '</div>' +
            '<div class="meta-line">' +
            '<span>' + (r.every ? '定时 ' + esc(r.every) : '来源 ' + esc(r.source) + ' (' + esc((r.types || []).join(', ')) + ')') + '</span>' +
            '<span>→</span>' +
            '<span class="mono">' + esc(r.agent) + '</span>' +
            '</div>' +
            '<div class="meta-line" style="margin-top:3px;">' +
            '<span class="mono">完成 ' + fmtNum(r.totals.done) + '</span>' +
            '<span>·</span>' +
            '<span class="mono">在跑 ' + fmtNum(r.totals.running) + '</span>' +
            '<span>·</span>' +
            '<span class="mono">' + fmtNum(r.totals.usage.input + r.totals.usage.output) + ' Token</span>' +
            '</div>' +
            '</div>'
        )
        .join('');

      const agentsHtml = state.agents
        .map(
          (a) =>
            '<div class="pipeline-item">' +
            '<div class="pipeline-item-name">' + esc(a.name) + ' <span class="mono status-muted">(' + esc(a.id) + ')</span></div>' +
            '<div class="meta-line">' +
            (a.online ? '<span class="status-ok">在线</span>' : '<span class="status-muted">离线</span>') +
            '<span>·</span>' +
            '<span>机器 <strong class="mono">' + esc(a.worker) + '</strong></span>' +
            '<span>·</span>' +
            '<span>插件 <strong class="mono">' + esc(a.use) + '</strong></span>' +
            '</div>' +
            '</div>'
        )
        .join('');

      const channelsHtml = state.channels.length
        ? state.channels
            .map(
              (c) =>
                '<div class="pipeline-item">' +
                '<div class="pipeline-item-name">' + esc(c.name) + ' <span class="mono status-muted">(' + esc(c.id) + ')</span></div>' +
                '<div class="meta-line">' +
                (c.online ? '<span class="status-ok">在线</span>' : '<span class="status-muted">待连接 / 网页链接</span>') +
                '</div>' +
                '</div>'
            )
            .join('')
        : '<div class="pipeline-item"><div class="section-desc">暂未配置外部通道，可直接在控制台内回答卡片</div></div>';

      document.getElementById('pipeline-container').innerHTML =
        '<div class="pipeline-col"><div class="pipeline-col-title">01. 事件来源与定时触发</div>' + sourcesHtml + '</div>' +
        '<div class="pipeline-col"><div class="pipeline-col-title">02. 分派规则（点击查轮次）</div>' + rulesHtml + '</div>' +
        '<div class="pipeline-col"><div class="pipeline-col-title">03. 接单 Agent 与 Worker</div>' + agentsHtml + '</div>' +
        '<div class="pipeline-col"><div class="pipeline-col-title">04. 通知与拍板通道</div>' + channelsHtml + '</div>';

      // Overview recent runs table (top 8)
      const recentRuns = state.runs.slice(0, 8);
      document.getElementById('overview-runs-tbody').innerHTML = recentRuns.length
        ? recentRuns.map((r) => renderRunRow(r, true)).join('')
        : '<tr><td colspan="10" style="text-align:center;color:var(--text-muted);padding:24px;">暂无执行记录，点击右上方「模拟触发一轮完整流程」或「发送事件」体验</td></tr>';
    }

    function formatRunState(run) {
      if (run.state === 'queued' && run.attempts > 0) {
        return '<span class="status-warn">等重派 (第 ' + run.attempts + ' 次)</span>';
      }
      const item = STATE_LABELS[run.state] || { text: run.state, cls: '' };
      return '<span class="' + item.cls + '">' + esc(item.text) + '</span>';
    }

    function renderRunRow(r, compact) {
      const ev = (r.events && r.events[0]) || null;
      const evText = ev
        ? '<span class="mono">' + esc(ev.source + ':' + ev.type) + '</span>' + (ev.subject ? ' · ' + esc(ev.subject) : '')
        : '<span class="status-muted">定时触发 / 内部</span>';
      const outcome = r.summary || r.error || '—';
      const inTok = r.usage ? r.usage.input || 0 : 0;
      const outTok = r.usage ? r.usage.output || 0 : 0;
      const totalTok = inTok + outTok;
      const costStr = r.usage && r.usage.cost !== undefined ? fmtCost(r.usage.cost) : '—';
      const canStop = (r.state === 'claimed' || r.state === 'queued') && !r.stopping;

      if (compact) {
        return (
          '<tr>' +
          '<td class="mono">#' + r.id + '</td>' +
          '<td style="font-weight:600;">' + esc(r.rule) + '</td>' +
          '<td class="mono">' + esc(r.agent) + '</td>' +
          '<td>' + formatRunState(r) + '</td>' +
          '<td>' + evText + '</td>' +
          '<td style="max-width:300px;">' + esc(outcome) + '</td>' +
          '<td class="num-col">' + (r.usage ? fmtNum(totalTok) : '—') + '</td>' +
          '<td class="num-col">' + costStr + '</td>' +
          '<td class="mono">' + fmtTime(r.finishedAt || r.claimedAt || r.createdAt) + '</td>' +
          '<td>' +
          '<div style="display:flex;gap:6px;">' +
          '<button class="btn btn-sm" onclick="openWhyModal(' + r.id + ')">因果时间线</button>' +
          (canStop ? '<button class="btn btn-sm btn-danger" onclick="cancelRun(' + r.id + ')">停止</button>' : '') +
          '</div>' +
          '</td>' +
          '</tr>'
        );
      }

      return (
        '<tr>' +
        '<td class="mono">#' + r.id + '</td>' +
        '<td style="font-weight:600;">' + esc(r.rule) + '</td>' +
        '<td class="mono">' + esc(r.agent) + '</td>' +
        '<td>' + formatRunState(r) + '</td>' +
        '<td>' + evText + '</td>' +
        '<td style="max-width:320px;">' + esc(outcome) + '</td>' +
        '<td class="num-col">' + (r.usage ? fmtNum(inTok) : '—') + '</td>' +
        '<td class="num-col">' + (r.usage ? fmtNum(outTok) : '—') + '</td>' +
        '<td class="num-col">' + costStr + '</td>' +
        '<td class="mono">' +
        (r.session ? '<div>' + esc(r.session) + '</div>' : '') +
        '<div class="status-muted">' + fmtTime(r.finishedAt || r.createdAt) + '</div>' +
        '</td>' +
        '<td>' +
        '<div style="display:flex;gap:6px;">' +
        '<button class="btn btn-sm" onclick="openWhyModal(' + r.id + ')">因果时间线</button>' +
        (canStop ? '<button class="btn btn-sm btn-danger" onclick="cancelRun(' + r.id + ')">停止</button>' : '') +
        '</div>' +
        '</td>' +
        '</tr>'
      );
    }

    function setRunStateFilter(state) {
      runStateFilter = state;
      document.querySelectorAll('#runs-state-seg .seg-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.state === state);
      });
      renderRunsView();
    }

    function jumpToRuleRuns(ruleName) {
      switchTab('runs');
      const sel = document.getElementById('runs-rule-filter');
      if (sel) {
        sel.value = ruleName;
        renderRunsView();
      }
    }

    function renderRunsView() {
      if (!appData) return;
      const { state } = appData;

      // Populate rule dropdown preserving selection
      const ruleSel = document.getElementById('runs-rule-filter');
      const prevRule = ruleSel.value;
      const ruleNames = state.lines.map((l) => l.name);
      ruleSel.innerHTML =
        '<option value="">全部规则 (' + ruleNames.length + ')</option>' +
        ruleNames.map((n) => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('');
      if (ruleNames.includes(prevRule)) ruleSel.value = prevRule;

      const q = (document.getElementById('runs-search').value || '').trim().toLowerCase();
      const selectedRule = ruleSel.value;

      const filtered = state.runs.filter((r) => {
        if (runStateFilter !== 'all' && r.state !== runStateFilter) return false;
        if (selectedRule && r.rule !== selectedRule) return false;
        if (!q) return true;
        const evStr = (r.events || []).map((e) => e.source + ' ' + e.type + ' ' + (e.subject || '') + ' ' + (e.summary || '')).join(' ');
        const hay = ('#' + r.id + ' ' + r.rule + ' ' + r.agent + ' ' + (r.summary || '') + ' ' + (r.error || '') + ' ' + evStr).toLowerCase();
        return hay.includes(q);
      });

      document.getElementById('runs-full-tbody').innerHTML = filtered.length
        ? filtered.map((r) => renderRunRow(r, false)).join('')
        : '<tr><td colspan="11" style="text-align:center;color:var(--text-muted);padding:24px;">没有匹配筛选条件的执行轮次</td></tr>';

      // Recent cards
      document.getElementById('recent-cards-tbody').innerHTML = state.recentCards.length
        ? state.recentCards
            .map((c) => {
              const chosen = c.choice !== null && c.options ? c.options[c.choice] : c.answer;
              const summary = [chosen ? '选择：' + chosen : '', c.result || ''].filter(Boolean).join(' · ') || c.text;
              return (
                '<tr>' +
                '<td class="mono">#' + c.id + '</td>' +
                '<td style="font-weight:600;">' + esc(c.title) + '</td>' +
                '<td>' + esc(summary) + '</td>' +
                '<td>' + esc(c.rule || '—') + '</td>' +
                '</tr>'
              );
            })
            .join('')
        : '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:18px;">暂无已结案卡片记录</td></tr>';

      // Unrouted events
      document.getElementById('unrouted-tbody').innerHTML = state.unrouted.length
        ? state.unrouted
            .map(
              (u) =>
                '<tr>' +
                '<td class="mono">' + esc(u.source) + '</td>' +
                '<td class="mono">' + esc(u.type) + '</td>' +
                '<td>' + esc(u.subject || '') + (u.summary ? ' · ' + esc(u.summary) : '') + '</td>' +
                '<td class="mono">' + fmtTime(u.received_at) + '</td>' +
                '</tr>'
            )
            .join('')
        : '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:18px;">所有事件均已匹配规则处理</td></tr>';
    }

    function renderTokensView() {
      if (!appData) return;
      const { state } = appData;
      const sp = state.spending;
      const totalUsage = state.totals.usage;

      document.getElementById('token-kpis').innerHTML = [
        {
          label: '今日 Token 消耗',
          val: fmtNum(sp.today.tokens),
          sub:
            '今日完成 ' +
            fmtNum(sp.today.rounds) +
            ' 轮' +
            (sp.today.missingTokens ? '（' + sp.today.missingTokens + ' 轮未上报）' : ''),
        },
        {
          label: '今日估算费用',
          val: fmtCost(sp.today.cost),
          sub: sp.today.missingCost ? sp.today.missingCost + ' 轮未包含费用字段' : '全部轮次均已上报费用',
        },
        {
          label: '最近 7 天 Token 消耗',
          val: fmtNum(sp.week.tokens),
          sub: '近 7 天 ' + fmtNum(sp.week.rounds) + ' 轮 · 费用 ' + fmtCost(sp.week.cost),
        },
        {
          label: '历史累计总 Token / 费用',
          val: fmtNum(totalUsage.input + totalUsage.output),
          sub: '输入 ' + fmtNum(totalUsage.input) + ' · 输出 ' + fmtNum(totalUsage.output) + ' · 累计 ' + fmtCost(totalUsage.cost),
        },
      ]
        .map(
          (k) =>
            '<div class="surface-box">' +
            '<div class="kpi-label">' + esc(k.label) + '</div>' +
            '<div class="kpi-value">' + esc(k.val) + '</div>' +
            '<div class="kpi-sub">' + esc(k.sub) + '</div>' +
            '</div>'
        )
        .join('');

      const maxRuleTok = Math.max(
        1,
        ...state.lines.map((l) => (l.totals.usage.input || 0) + (l.totals.usage.output || 0))
      );

      document.getElementById('tokens-by-rule-tbody').innerHTML = state.lines
        .map((l) => {
          const inp = l.totals.usage.input || 0;
          const out = l.totals.usage.output || 0;
          const tot = inp + out;
          const pct = Math.min(100, Math.round((tot / maxRuleTok) * 100));
          return (
            '<tr>' +
            '<td>' +
            '<div style="font-weight:600;">' + esc(l.name) + '</div>' +
            '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%;"></div></div>' +
            '</td>' +
            '<td class="mono">' + esc(l.agent) + '</td>' +
            '<td class="num-col">' + fmtNum(l.totals.done) + '</td>' +
            '<td class="num-col">' + fmtNum(inp) + '</td>' +
            '<td class="num-col">' + fmtNum(out) + '</td>' +
            '<td class="num-col">' + fmtNum(tot) + '</td>' +
            '<td class="num-col">' + fmtCost(l.totals.usage.cost) + '</td>' +
            '</tr>'
          );
        })
        .join('');

      document.getElementById('tokens-by-agent-tbody').innerHTML = state.agents
        .map((a) => {
          const tot = (a.totals.usage.input || 0) + (a.totals.usage.output || 0);
          return (
            '<tr>' +
            '<td style="font-weight:600;">' + esc(a.name) + ' <span class="mono status-muted">(' + esc(a.id) + ')</span></td>' +
            '<td class="mono">' + esc(a.use) + ' · ' + esc(a.worker) + '</td>' +
            '<td>' + (a.online ? '<span class="status-ok">在线</span>' : '<span class="status-muted">离线</span>') + '</td>' +
            '<td class="num-col">' + fmtNum(a.totals.done) + '</td>' +
            '<td class="num-col">' + fmtNum(tot) + '</td>' +
            '<td class="num-col">' + fmtCost(a.totals.usage.cost) + '</td>' +
            '</tr>'
          );
        })
        .join('');

      const runsWithUsage = state.runs.filter((r) => r.usage);
      document.getElementById('tokens-ledger-tbody').innerHTML = runsWithUsage.length
        ? runsWithUsage
            .map((r) => {
              const inp = r.usage.input || 0;
              const out = r.usage.output || 0;
              return (
                '<tr>' +
                '<td class="mono">#' + r.id + '</td>' +
                '<td style="font-weight:600;">' + esc(r.rule) + '</td>' +
                '<td class="mono">' + esc(r.agent) + '</td>' +
                '<td class="mono">' + fmtTime(r.finishedAt || r.createdAt) + '</td>' +
                '<td>' + esc(r.summary || '—') + '</td>' +
                '<td class="num-col">' + fmtNum(inp) + '</td>' +
                '<td class="num-col">' + fmtNum(out) + '</td>' +
                '<td class="num-col">' + fmtNum(inp + out) + '</td>' +
                '<td class="num-col">' + fmtCost(r.usage.cost) + '</td>' +
                '</tr>'
              );
            })
            .join('')
        : '<tr><td colspan="9" style="text-align:center;color:var(--text-muted);padding:20px;">暂无带 Token 统计的轮次</td></tr>';
    }

    function renderConfigView() {
      if (!appData) return;
      document.getElementById('config-explain-box').textContent = (appData.explain || []).join('\\n');
      document.getElementById('rules-file-path-label').textContent = '文件路径：' + (appData.rulesFile || 'rules.json');
      const editor = document.getElementById('rules-json-editor');
      if (!editorDirty) {
        editor.value = appData.rulesRaw || '';
      }

      document.getElementById('keys-tbody').innerHTML = (appData.keys || [])
        .map(
          (k) =>
            '<tr>' +
            '<td class="mono">' + esc(k.kind) + '</td>' +
            '<td class="mono" style="font-weight:600;">' + esc(k.name) + '</td>' +
            '<td class="mono">' + fmtTime(k.created_at) + '</td>' +
            '<td><button class="btn btn-sm btn-danger" onclick="revokeKey(\\'' + esc(k.kind) + '\\', \\'' + esc(k.name) + '\\')">吊销失效</button></td>' +
            '</tr>'
        )
        .join('');
    }

    document.addEventListener('DOMContentLoaded', () => {
      const editor = document.getElementById('rules-json-editor');
      if (editor) {
        editor.addEventListener('input', () => {
          editorDirty = true;
        });
      }
    });

    function toggleQuickBuilderMode() {
      const mode = document.getElementById('qb-mode').value;
      document.getElementById('qb-event-fields').classList.toggle('hidden', mode !== 'event');
      document.getElementById('qb-cron-fields').classList.toggle('hidden', mode !== 'cron');
    }

    async function appendRuleToEditor() {
      const name = document.getElementById('qb-name').value.trim();
      if (!name) return showToast('请先填写规则名称');
      const mode = document.getElementById('qb-mode').value;
      const to = document.getElementById('qb-agent').value.trim() || 'agent';
      const cwd = document.getElementById('qb-cwd').value.trim() || '~/project';
      const prompt = document.getElementById('qb-prompt').value.trim() || '按规则处理事件。';

      let obj;
      try {
        obj = JSON.parse(document.getElementById('rules-json-editor').value);
      } catch (e) {
        return showToast('右侧 JSON 格式有误，请先修复后再追加');
      }

      let when;
      if (mode === 'event') {
        const source = document.getElementById('qb-source').value.trim() || 'local';
        const types = document
          .getElementById('qb-types')
          .value.split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (!types.length) return showToast('请填写至少一个事件类型');
        obj.sources = obj.sources || {};
        if (!obj.sources[source]) {
          obj.sources[source] = { name: source };
        }
        when = { source, types };
      } else {
        const cron = document.getElementById('qb-cron').value.trim();
        if (!cron) return showToast('请填写 Cron 表达式');
        when = { cron };
      }

      obj.rules = obj.rules || [];
      obj.rules.push({ name, when, to, cwd, prompt });
      document.getElementById('rules-json-editor').value = JSON.stringify(obj, null, 2);
      editorDirty = true;
      await saveRulesEditor();
      document.getElementById('qb-name').value = '';
    }

    async function validateRulesEditor() {
      const raw = document.getElementById('rules-json-editor').value;
      const msgEl = document.getElementById('rules-validation-msg');
      try {
        const res = await fetch('/api/console/rules/validate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rules: raw }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '校验未通过');
        msgEl.innerHTML = '<span class="status-ok">校验通过：共 ' + data.parsed.rules.length + ' 条规则有效</span>';
        document.getElementById('config-explain-box').textContent = (data.explain || []).join('\\n');
        showToast('规则语法与字段校验通过');
      } catch (err) {
        msgEl.innerHTML = '<span class="status-err">校验失败：' + esc(err.message) + '</span>';
      }
    }

    async function saveRulesEditor() {
      const raw = document.getElementById('rules-json-editor').value;
      const msgEl = document.getElementById('rules-validation-msg');
      try {
        const res = await fetch('/api/console/rules', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rules: raw }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '保存失败');
        editorDirty = false;
        document.getElementById('rules-json-editor').value = data.rulesRaw;
        msgEl.innerHTML = '<span class="status-ok">已保存并热加载生效（' + fmtTime(new Date().toISOString()) + '）</span>';
        showToast('rules.json 已保存并立即生效');
        await refreshAll();
      } catch (err) {
        msgEl.innerHTML = '<span class="status-err">保存失败：' + esc(err.message) + '</span>';
      }
    }

    async function createNewKey() {
      const kind = document.getElementById('new-key-kind').value;
      const name = document.getElementById('new-key-name').value.trim();
      if (!name) return showToast('请填写密钥名称');
      const res = await fetch('/api/console/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, name }),
      });
      const data = await res.json();
      if (!res.ok) return showToast(data.error || '新建密钥失败');
      const banner = document.getElementById('created-secret-banner');
      banner.classList.remove('hidden');
      banner.textContent = '新建成功（只显示这一次，请立即复制保存）：\\n' + data.kind + ' / ' + data.name + ' = ' + data.secret;
      document.getElementById('new-key-name').value = '';
      await refreshAll();
    }

    async function revokeKey(kind, name) {
      const res = await fetch('/api/console/keys/' + encodeURIComponent(kind) + '/' + encodeURIComponent(name), {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) return showToast(data.error || '吊销失败');
      showToast('密钥 ' + kind + ':' + name + ' 已立即失效');
      await refreshAll();
    }

    function renderHealthCards() {
      if (!appData || !appData.health) return;
      const h = appData.health;
      const sv = h.services;
      document.getElementById('health-cards-grid').innerHTML = [
        {
          label: 'SQLite 事实与投影库 (database)',
          val: sv.database.connected ? '正常连接' : '连接异常',
          cls: sv.database.connected ? 'status-ok' : 'status-err',
          sub: 'WAL 模式 · 单事务演化与持久化',
        },
        {
          label: '规则配置引擎 (rules.json)',
          val: sv.rules.loaded ? '已加载有效' : '解析错误',
          cls: sv.rules.loaded ? 'status-ok' : 'status-err',
          sub: sv.rules.error || '支持文件监听自动热更新',
        },
        {
          label: '中台调度内核 (hub)',
          val: sv.hub.status === 'ok' ? '运行中' : '异常',
          cls: sv.hub.status === 'ok' ? 'status-ok' : 'status-err',
          sub: '进程已运行 ' + Math.floor(h.uptime || 0) + ' 秒 · 提交 ' + String(h.commit).slice(0, 12),
        },
        {
          label: '本机接单 Worker',
          val: sv.worker.online ? '在线 (' + (sv.worker.name || 'worker') + ')' : '待心跳 (' + (sv.worker.name || 'worker') + ')',
          cls: sv.worker.online ? 'status-ok' : 'status-warn',
          sub: '长轮询领取任务与独立进程组守护',
        },
      ]
        .map(
          (c) =>
            '<div class="surface-box">' +
            '<div class="kpi-label">' + esc(c.label) + '</div>' +
            '<div class="kpi-value ' + c.cls + '" style="font-size:20px;">' + esc(c.val) + '</div>' +
            '<div class="kpi-sub">' + esc(c.sub) + '</div>' +
            '</div>'
        )
        .join('');
    }

    function setFactTypeFilter(ftype) {
      factTypeFilter = ftype;
      document.querySelectorAll('#logs-type-seg .seg-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.ftype === ftype);
      });
      renderFactLogsTable();
    }

    async function loadFactLogs() {
      try {
        const res = await fetch('/api/console/logs?after=0&limit=150&order=desc');
        const data = await res.json();
        factLogs = data.facts || [];
        document.getElementById('logs-count-label').textContent =
          '共记录 ' + fmtNum(data.total) + ' 条事实 · 最新序号 #' + fmtNum(data.maxSeq);
        renderFactLogsTable();
      } catch (err) {
        showToast('读取事实日志失败：' + err.message);
      }
    }

    function summarizeFact(f) {
      const changes = f.changes || [];
      if (f.type === 'ingest') {
        const ev = changes.find((c) => c.table === 'events' && c.row)?.row;
        return ev ? '收到事件 [' + ev.source + '] ' + ev.type + ' ' + (ev.subject || '') : '记录外部事件';
      }
      if (f.type === 'claimNext') {
        const r = changes.find((c) => c.table === 'runs' && c.row)?.row;
        return r ? '派发第 #' + r.id + ' 轮（规则：' + r.rule + '，Agent：' + r.agent + '）' : '接单程序领活';
      }
      if (f.type === 'started') {
        const r = changes.find((c) => c.table === 'runs' && c.row)?.row;
        return r ? '第 #' + r.id + ' 轮上报启动，会话 ' + (r.session || '') : '轮次开始处理';
      }
      if (f.type === 'finish') {
        const r = changes.find((c) => c.table === 'runs' && c.row)?.row;
        return r ? '第 #' + r.id + ' 轮结束（' + r.state + '）：' + (r.summary || r.error || '') : '轮次结单回执';
      }
      if (f.type === 'answer') {
        const c = changes.find((x) => x.table === 'cards' && x.row)?.row;
        return c ? (c.by || '本人') + '回答卡片 #' + c.id + '「' + c.title + '」' : '回答卡片';
      }
      if (f.type === 'resolve') {
        const c = changes.find((x) => x.table === 'cards' && x.row)?.row;
        return c ? '结案卡片 #' + c.id + '：' + (c.result || '') : '卡片结案';
      }
      if (f.type === 'rules') {
        return '更新生效 rules.json 配置（版本 #' + f.seq + '）';
      }
      if (f.type === 'key') {
        const k = changes.find((x) => x.table === 'keys' && x.row)?.row;
        return k ? '登记门禁密钥 ' + k.kind + ':' + k.name : '密钥变更';
      }
      return '变更 ' + changes.length + ' 项记录';
    }

    function renderFactLogsTable() {
      const q = (document.getElementById('logs-search').value || '').trim().toLowerCase();
      const filtered = factLogs.filter((f) => {
        if (factTypeFilter !== 'all' && f.type !== factTypeFilter) return false;
        if (!q) return true;
        const raw = JSON.stringify(f).toLowerCase();
        return raw.includes(q);
      });

      document.getElementById('fact-logs-tbody').innerHTML = filtered.length
        ? filtered
            .map((f, idx) => {
              const tables = [...new Set((f.changes || []).map((c) => c.table + ':' + c.key))].slice(0, 4).join(', ');
              return (
                '<tr>' +
                '<td class="mono">#' + f.seq + '</td>' +
                '<td class="mono" style="font-weight:600;">' + esc(f.type) + '</td>' +
                '<td class="mono">' + fmtTime(f.at) + '</td>' +
                '<td class="mono status-muted">' + esc(tables || '—') + '</td>' +
                '<td>' + esc(summarizeFact(f)) + '</td>' +
                '<td><button class="btn btn-sm" onclick="openFactModal(' + f.seq + ')">查看 JSON</button></td>' +
                '</tr>'
              );
            })
            .join('')
        : '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:20px;">没有匹配的事实日志记录</td></tr>';
    }

    function openFactModal(seq) {
      const found = factLogs.find((f) => f.seq === seq);
      if (!found) return;
      document.getElementById('fact-modal-title').textContent = '事实记录 #' + seq + ' (' + found.type + ')';
      document.getElementById('fact-modal-box').textContent = JSON.stringify(found, null, 2);
      document.getElementById('fact-modal').classList.add('open');
    }

    function closeFactModal() {
      document.getElementById('fact-modal').classList.remove('open');
    }

    async function openWhyModal(runId) {
      document.getElementById('why-modal-title').textContent = '第 #' + runId + ' 轮 · 因果时间线（why）';
      document.getElementById('why-formatted-box').textContent = '正在加载时间线…';
      document.getElementById('why-facts-box').textContent = '';
      document.getElementById('why-modal').classList.add('open');
      try {
        const res = await fetch('/api/console/runs/' + runId + '/why');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '加载失败');
        document.getElementById('why-formatted-box').textContent = data.formatted;
        document.getElementById('why-facts-box').textContent = JSON.stringify(data.facts, null, 2);
      } catch (err) {
        document.getElementById('why-formatted-box').textContent = '读取失败：' + err.message;
      }
    }

    function closeWhyModal() {
      document.getElementById('why-modal').classList.remove('open');
    }

    async function cancelRun(runId) {
      const res = await fetch('/api/console/runs/' + runId + '/cancel', { method: 'POST' });
      if (res.ok) {
        showToast('已通知停止第 #' + runId + ' 轮');
        await refreshAll();
      }
    }

    async function answerCard(cardId, choice) {
      const res = await fetch('/api/console/cards/' + cardId + '/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ choice }),
      });
      const data = await res.json();
      if (!res.ok) return showToast(data.error || '提交回答失败');
      showToast('已提交选择，Agent 将接着处理');
      await refreshAll();
    }

    async function answerCardCustom(cardId, kind) {
      const input = document.getElementById('card-custom-' + cardId);
      const text = input ? input.value.trim() : '';
      if (kind === 'ask' && !text) return showToast('请先填写你的想法或直接点击上方选项按钮');
      const res = await fetch('/api/console/cards/' + cardId + '/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(text ? { text } : {}),
      });
      const data = await res.json();
      if (!res.ok) return showToast(data.error || '处理失败');
      showToast(kind === 'ask' ? '已发送你的回答，Agent 将接着处理' : '通知卡片已结案');
      await refreshAll();
    }

    async function resolveCardPrompt(cardId) {
      const input = document.getElementById('card-custom-' + cardId);
      const reason = (input && input.value.trim()) || '已在控制台手动确认结案';
      const res = await fetch('/api/console/cards/' + cardId + '/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      const data = await res.json();
      if (!res.ok) return showToast(data.error || '结案失败');
      showToast('卡片 #' + cardId + ' 已结案');
      await refreshAll();
    }

    function openEmitModal() {
      const sel = document.getElementById('emit-source');
      const sources = (appData && appData.state && appData.state.sources) || [{ id: 'local', name: '本机' }];
      sel.innerHTML = sources
        .map((s) => '<option value="' + esc(s.id) + '">' + esc(s.name) + ' (' + esc(s.id) + ')</option>')
        .join('');
      document.getElementById('emit-preview-output').classList.add('hidden');
      document.getElementById('emit-modal').classList.add('open');
    }

    function closeEmitModal() {
      document.getElementById('emit-modal').classList.remove('open');
    }

    async function runEmitPreview() {
      const payload = {
        source: document.getElementById('emit-source').value,
        type: document.getElementById('emit-type').value.trim(),
        subject: document.getElementById('emit-subject').value.trim(),
        summary: document.getElementById('emit-summary').value.trim(),
        detail: document.getElementById('emit-detail').value.trim(),
      };
      const out = document.getElementById('emit-preview-output');
      out.classList.remove('hidden');
      try {
        const res = await fetch('/api/console/preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '预演失败');
        out.textContent = (data.lines || []).join('\\n');
      } catch (err) {
        out.textContent = '预演失败：' + err.message;
      }
    }

    async function submitEmitEvent() {
      const payload = {
        source: document.getElementById('emit-source').value,
        type: document.getElementById('emit-type').value.trim(),
        subject: document.getElementById('emit-subject').value.trim(),
        summary: document.getElementById('emit-summary').value.trim(),
        detail: document.getElementById('emit-detail').value.trim(),
      };
      const res = await fetch('/api/console/emit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) return showToast(data.error || '发送事件失败');
      closeEmitModal();
      showToast(
        data.routed && data.routed.length
          ? '事件已派给规则：' + data.routed.join('、')
          : '事件已记入日志（无匹配规则）'
      );
      await refreshAll();
    }

    async function triggerDemoRun() {
      const res = await fetch('/api/console/demo', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) return showToast(data.error || '触发失败');
      showToast('已模拟触发并完成第 #' + (data.run || '') + ' 轮，Token 与时间线已更新');
      await refreshAll();
    }

    refreshAll();
    setInterval(refreshAll, 5000);
  </script>
</body>
</html>`;
