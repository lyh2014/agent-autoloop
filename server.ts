// Entry point for AI Studio dev server and deployment, including /health service monitoring and visual console.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { handleConsoleRequest, seedInitialDemoData } from "./console.ts";
import { loadChannel } from "./host/channels.ts";
import { CONFIG_FILE, readConfig, writeConfig, type ChannelConfig, type Config } from "./host/config.ts";
import { HOME, RULES_FILE } from "./host/home.ts";
import { makeHandler } from "./host/server.ts";
import { commitOf } from "./host/version.ts";
import { hubClient } from "./protocol/client.ts";
import { createWorker } from "./worker/worker.ts";

// AI Studio routes container traffic through nginx to port 3000
const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "0.0.0.0";

function ensureInitialized() {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(HOME, "try"), { recursive: true });

  if (!existsSync(RULES_FILE)) {
    const defaultRules = {
      sources: { local: { name: "本机" } },
      agents: {
        agent: { name: "Agent", worker: "this-machine", use: "command", command: ["echo", "{prompt}"] },
      },
      channels: { plain: { name: "文字", links: true } },
      rules: [
        {
          name: "试一下",
          when: { source: "local", types: ["try.*"] },
          to: "agent",
          cwd: path.join(HOME, "try"),
          prompt:
            "这是 agent-autoloop try 的试跑，不要改任何文件，不要做别的事。读资料文件。" +
            "如果 answers 是空的，就问一个问题：title 写“试跑：选一个颜色”，text 写“这是一次试跑，选哪个都行。”，" +
            'options 写 ["蓝色","绿色"]，key 写 try-color，第一行结论写“问了一个问题”。' +
            "如果 answers 不是空的，第一行结论写“你选了某某，试跑通过”，把某某换成 answers 里选的那一项，不附回执。",
        },
      ],
      elsewhere: [],
    };
    writeFileSync(RULES_FILE, `${JSON.stringify(defaultRules, null, 2)}\n`, { mode: 0o600 });
  }
}

export async function checkHealth() {
  const hub = await import("./host/runtime.ts");
  const commit = commitOf();

  let dbConnected = false;
  let dbError: string | undefined;
  try {
    const meta = hub.one<{ format: string }>("SELECT format FROM projection_meta");
    dbConnected = Boolean(meta?.format);
  } catch (error) {
    dbError = (error as Error).message ?? String(error);
  }

  let rulesValid = false;
  let rulesError: string | undefined;
  const activeRulesFile = process.env.AGENT_AUTOLOOP_RULES
    ? path.resolve(process.env.AGENT_AUTOLOOP_RULES)
    : RULES_FILE;
  try {
    const text = readFileSync(activeRulesFile, "utf8");
    hub.parseRules(text);
    rulesValid = true;
  } catch (error) {
    rulesError = (error as Error).message ?? String(error);
  }

  let hubStatus: {
    status: "ok" | "error";
    running?: number;
    queued?: number;
    doneToday?: number;
    openCards?: number;
    error?: string;
  } = { status: "error" };
  let workerStatus: {
    status: "ok" | "offline" | "unconfigured";
    name?: string;
    online?: boolean;
  } = { status: "unconfigured" };

  try {
    const state = hub.stateOf() as {
      totals: { running: number; queued: number; doneToday: number };
      cards: unknown[];
      agents: { name: string; worker: string; online: boolean }[];
    };
    hubStatus = {
      status: "ok",
      running: state.totals.running,
      queued: state.totals.queued,
      doneToday: state.totals.doneToday,
      openCards: state.cards.length,
    };
    const config = existsSync(CONFIG_FILE) ? readConfig() : undefined;
    const workerName = config?.worker?.name;
    const online = workerName
      ? state.agents.some((agent) => agent.worker === workerName && agent.online)
      : state.agents.some((agent) => agent.online);
    workerStatus = {
      status: online ? "ok" : workerName ? "offline" : "unconfigured",
      ...(workerName && { name: workerName }),
      online,
    };
  } catch (error) {
    hubStatus = { status: "error", error: (error as Error).message ?? String(error) };
  }

  const ok = dbConnected && rulesValid && hubStatus.status === "ok";
  return {
    ok,
    status: ok ? "ok" : "degraded",
    commit,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    services: {
      database: {
        status: dbConnected ? "ok" : "error",
        connected: dbConnected,
        ...(dbError && { error: dbError }),
      },
      rules: {
        status: rulesValid ? "ok" : "error",
        loaded: rulesValid,
        ...(rulesError && { error: rulesError }),
      },
      hub: hubStatus,
      worker: workerStatus,
    },
  };
}

async function keepRunning(say: (line: string) => void, run: () => Promise<unknown>, signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      await run();
      if (signal.aborted) return;
      say("stopped; starting again in 30 seconds");
    } catch (error) {
      say(`stopped: ${error}; starting again in 30 seconds`);
    }
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
}

export async function startServer(
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
  { startWorker = true }: { startWorker?: boolean } = {},
) {
  ensureInitialized();
  const { addKey } = await import("./host/runtime.ts");

  const listenPort = port || DEFAULT_PORT;
  if (!existsSync(CONFIG_FILE)) {
    const url = `http://127.0.0.1:${listenPort}`;
    const config: Config = {
      url,
      hub: {
        listen: `${host}:${listenPort}`,
        publicUrl: url,
      },
      worker: {
        name: "this-machine",
        key: addKey("worker", "this-machine"),
      },
      source: {
        name: "local",
        key: addKey("source", "local"),
      },
      owner: addKey("owner", "owner"),
      channels: {},
    };
    writeConfig(config);
  } else if (port !== 0) {
    try {
      const config = readConfig();
      let changed = false;
      if (config.hub && config.hub.listen !== `${host}:${port}`) {
        config.hub.listen = `${host}:${port}`;
        changed = true;
      }
      const expectedUrl = `http://127.0.0.1:${port}`;
      if (config.url !== expectedUrl) {
        config.url = expectedUrl;
        changed = true;
      }
      if (config.channels?.plain) {
        delete config.channels.plain;
        changed = true;
      }
      if (changed) writeConfig(config);
    } catch {}
  }

  const secretsFile = path.join(HOME, "secrets.env");
  if (existsSync(secretsFile)) process.loadEnvFile(secretsFile);

  const commit = commitOf();
  const runtime = makeHandler(commit);
  const stop = new AbortController();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && reqUrl.pathname === "/health") {
      try {
        const report = await checkHealth();
        res.writeHead(report.ok ? 200 : 503, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(report));
      } catch (error) {
        res.writeHead(503, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(
          JSON.stringify({
            ok: false,
            status: "error",
            error: (error as Error).message ?? "健康检查出错了",
          }),
        );
      }
      return;
    }

    if (await handleConsoleRequest(req, res, checkHealth)) {
      return;
    }

    const gone = new AbortController();
    res.on("close", () => gone.abort());
    try {
      const body = !["GET", "HEAD"].includes(req.method!) && {
        body: Readable.toWeb(req) as ReadableStream,
        duplex: "half",
      };
      const headers = req.headers as HeadersInit;
      const request = new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers,
        signal: gone.signal,
        ...body,
      });
      const answer = await runtime.handle(request);
      if (!req.complete) res.setHeader("connection", "close");
      res.writeHead(answer.status, Object.fromEntries(answer.headers));
      if (!answer.body) return void res.end();
      Readable.fromWeb(answer.body as any)
        .on("error", () => res.destroy())
        .pipe(res);
    } catch (error) {
      console.error(error);
      if (res.headersSent) return void res.end();
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "中台出错了" }));
    }
  });

  server.on("close", runtime.close);
  server.listen({ port, host, backlog: 2048 });

  if (startWorker) {
    const config = readConfig();
    const log = (who: string) => (line: string) => console.log(`${new Date().toISOString()} [${who}] ${line}`);
    if (config.worker) {
      const { key, name, capacity, unreachable } = config.worker;
      const say = log("worker");
      const worker = createWorker({ hub: hubClient(config.url, key), name, capacity, unreachable, log: say });
      void keepRunning(say, () => worker.run(stop.signal), stop.signal);
    }
    for (const [id, channel] of Object.entries(config.channels ?? {})) {
      const { use, key, ...options } = channel as ChannelConfig;
      const say = log(id);
      void keepRunning(
        say,
        async () => {
          const start = await loadChannel(use ?? id);
          await start({ hub: hubClient(config.url, key), options, log: say, signal: stop.signal });
        },
        stop.signal,
      );
    }
  }

  return {
    server,
    close() {
      stop.abort();
      server.closeAllConnections();
      server.close();
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const app = await startServer(DEFAULT_PORT, DEFAULT_HOST);
  await seedInitialDemoData().catch(() => {});
  app.server.on("listening", () => {
    console.log(`${new Date().toISOString()} [hub] listening on ${DEFAULT_HOST}:${DEFAULT_PORT}`);
  });
  const finish = () => {
    app.close();
    process.exit(0);
  };
  process.on("SIGTERM", finish);
  process.on("SIGINT", finish);
}
