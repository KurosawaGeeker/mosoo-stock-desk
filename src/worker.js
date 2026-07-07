const MAIL_TO = "363876315@qq.com";
const TICKER = "MU";

const AGENTS = {
  market: {
    key: "market",
    name: "MU 盯盘员",
    env: "MOSOO_AGENT_MU_WATCH_URL",
    color: "green",
    mission:
      "盯住 Micron Technology, Inc. (NASDAQ: MU) 的盘面、关键价位、成交量、波动和技术风险。用户写 MUU 时按 MU 理解。"
  },
  news: {
    key: "news",
    name: "信息面收集员",
    env: "MOSOO_AGENT_INFO_URL",
    color: "amber",
    mission:
      "收集 MU 的信息面，包括公司新闻、财报、分析师观点、DRAM/NAND 行业、AI 存储需求和宏观利率风险。"
  },
  decision: {
    key: "decision",
    name: "交易决策员",
    env: "MOSOO_AGENT_DECISION_URL",
    color: "red",
    mission:
      "整合盯盘员和信息面收集员的结论，输出研究用途的买入/卖出/观望建议、置信度、风险和邮件正文。"
  }
};

const TERMINAL_RUN_TYPES = new Set([
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.expired"
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/") {
        return htmlResponse(renderHome());
      }

      if (url.pathname === "/api/config" && request.method === "GET") {
        return jsonResponse({
          ticker: TICKER,
          mailTo: env.MAIL_TO || MAIL_TO,
          agents: Object.fromEntries(
            Object.entries(AGENTS).map(([key, agent]) => [
              key,
              {
                key,
                name: agent.name,
                mission: agent.mission,
                color: agent.color,
                configured: Boolean(env[agent.env] || env[`MOSOO_AGENT_${key.toUpperCase()}_ID`])
              }
            ])
          )
        });
      }

      if (url.pathname === "/api/market/mu" && request.method === "GET") {
        return jsonResponse(await fetchMarketSnapshot());
      }

      if (url.pathname === "/api/news/mu" && request.method === "GET") {
        return jsonResponse(await fetchNewsSnapshot());
      }

      const agentMatch = url.pathname.match(/^\/api\/agents\/([a-z]+)\/(message|events)$/);
      if (agentMatch) {
        const [, agentKey, action] = agentMatch;
        const agent = AGENTS[agentKey];
        if (!agent) {
          return jsonResponse({ error: "unknown_agent" }, 404);
        }

        if (action === "message" && request.method === "POST") {
          const body = await readJson(request);
          return jsonResponse(await handleAgentMessage(agent, body, env));
        }

        if (action === "events" && request.method === "GET") {
          const threadId = url.searchParams.get("threadId");
          if (!threadId) {
            return jsonResponse({ error: "missing_thread_id" }, 400);
          }
          const binding = resolveAgentBinding(agent, env);
          const events = await listThreadEvents(binding, threadId);
          return jsonResponse(summarizeEvents(threadId, events));
        }
      }

      if (url.pathname === "/api/email" && request.method === "POST") {
        const body = await readJson(request);
        return jsonResponse(await sendDecisionEmail(env, body));
      }

      return htmlResponse(renderHome(), 404);
    } catch (error) {
      return jsonResponse(
        {
          error: "request_failed",
          message: error.message || "Request failed",
          detail: error.detail || null
        },
        error.status || 500
      );
    }
  }
};

async function handleAgentMessage(agent, body, env) {
  const text = String(body.text || "").trim();
  if (!text) {
    throw statusError(400, "missing_message", "请输入要发送给 Agent 的任务。");
  }

  const binding = resolveAgentBinding(agent, env);
  const waitMs = Math.min(Number(body.waitMs || 12000), 25000);
  let threadId = body.threadId ? String(body.threadId) : "";
  let response;

  if (threadId) {
    response = await sendThreadMessage(binding, threadId, text);
  } else {
    response = await createThread(binding, text, `${agent.key}-${Date.now()}`);
    threadId = findThreadId(response);
    if (!threadId) {
      throw statusError(502, "missing_thread_id", "Mosoo 没有返回 thread id。");
    }
  }

  let events = [];
  if (waitMs > 0) {
    events = await waitForThread(binding, threadId, waitMs);
  } else {
    events = await listThreadEvents(binding, threadId);
  }

  return {
    agent: agent.key,
    threadId,
    rawAccepted: response,
    ...summarizeEvents(threadId, events)
  };
}

function resolveAgentBinding(agent, env) {
  const raw =
    env[agent.env] ||
    env[`MOSOO_AGENT_${agent.key.toUpperCase()}_URL`] ||
    env[`MOSOO_AGENT_${agent.key.toUpperCase()}_ID`];

  if (!raw) {
    throw statusError(
      500,
      "agent_not_configured",
      `${agent.name} 缺少 ${agent.env} Mosoo deploy 绑定。`
    );
  }

  const token = env.MOSOO_API_TOKEN || env.MOSOO_PUBLIC_API_TOKEN || "";
  const apiBase = trimSlash(env.MOSOO_API_BASE || "https://try.mosoo.ai/api/v1");

  if (!looksLikeUrl(raw)) {
    return {
      apiBase,
      agentId: raw,
      token,
      query: ""
    };
  }

  const parsed = new URL(raw);
  const tokenFromUrl =
    parsed.searchParams.get("token") ||
    parsed.searchParams.get("access_token") ||
    parsed.searchParams.get("api_token") ||
    "";
  const agentId =
    parsed.searchParams.get("agentId") ||
    parsed.pathname.match(/\/agents\/([^/]+)/)?.[1] ||
    parsed.pathname.match(/\/agent\/([^/]+)/)?.[1] ||
    "";

  if (!agentId) {
    return {
      directThreadUrl: raw,
      token: token || tokenFromUrl,
      query: parsed.search
    };
  }

  const apiPrefix = parsed.pathname.includes("/api/v1")
    ? parsed.pathname.slice(0, parsed.pathname.indexOf("/api/v1") + "/api/v1".length)
    : "/api/v1";

  parsed.searchParams.delete("token");
  parsed.searchParams.delete("access_token");
  parsed.searchParams.delete("api_token");
  parsed.searchParams.delete("agentId");

  return {
    apiBase: `${parsed.origin}${apiPrefix}`,
    agentId,
    token: token || tokenFromUrl,
    query: parsed.search
  };
}

async function createThread(binding, text, externalRef) {
  const url = binding.directThreadUrl || `${binding.apiBase}/agents/${binding.agentId}/threads${binding.query || ""}`;
  const idempotency = `create-${externalRef}`.slice(0, 128);

  return mosooFetch(binding, url, {
    method: "POST",
    headers: { "Idempotency-Key": idempotency },
    body: {
      client_external_ref: externalRef,
      input: {
        type: "user.message",
        content: [{ type: "text", text }]
      }
    }
  });
}

async function sendThreadMessage(binding, threadId, text) {
  const url = `${binding.apiBase}/threads/${threadId}/events${binding.query || ""}`;
  const clientRequestId = `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`.slice(0, 96);

  return mosooFetch(binding, url, {
    method: "POST",
    headers: { "Idempotency-Key": clientRequestId },
    body: {
      events: [
        {
          type: "user_message",
          clientRequestId,
          text
        }
      ]
    }
  });
}

async function listThreadEvents(binding, threadId) {
  const url = `${binding.apiBase}/threads/${threadId}/events?limit=100${binding.query ? `&${binding.query.slice(1)}` : ""}`;
  const data = await mosooFetch(binding, url, { method: "GET" });
  return data.events || data.items || data.data?.events || data.data?.items || [];
}

async function waitForThread(binding, threadId, waitMs) {
  const started = Date.now();
  let events = [];

  while (Date.now() - started < waitMs) {
    events = await listThreadEvents(binding, threadId);
    if (hasTerminalRun(events)) {
      break;
    }
    await sleep(1200);
  }

  return events;
}

async function mosooFetch(binding, url, init) {
  const headers = new Headers(init.headers || {});
  headers.set("Accept", "application/json");
  if (init.body) {
    headers.set("Content-Type", "application/json");
  }
  if (binding.token) {
    headers.set("Authorization", `Bearer ${binding.token}`);
  }

  const response = await fetch(url, {
    method: init.method,
    headers,
    body: init.body ? JSON.stringify(init.body) : undefined
  });

  const text = await response.text();
  const data = parseJson(text);
  if (!response.ok) {
    const message = data?.error?.message || data?.message || `Mosoo API returned ${response.status}`;
    const error = statusError(response.status, data?.error?.code || "mosoo_api_error", message);
    error.detail = data || text.slice(0, 400);
    throw error;
  }
  return data || {};
}

function summarizeEvents(threadId, events) {
  const timeline = events.map((event) => ({
    id: event.id || "",
    type: event.type || event.event || "event",
    status: event.status || "",
    occurredAt: event.occurredAt || event.createdAt || "",
    text: eventText(event).slice(0, 1200)
  }));

  const output = collectAgentOutput(events);
  return {
    threadId,
    terminal: hasTerminalRun(events),
    output,
    timeline
  };
}

function hasTerminalRun(events) {
  return events.some((event) => TERMINAL_RUN_TYPES.has(event.type));
}

function collectAgentOutput(events) {
  const deltas = [];
  const fallback = [];

  for (const event of events) {
    const type = event.type || "";
    const text = eventText(event);
    if (!text) {
      continue;
    }
    if (type.includes("agent.message")) {
      deltas.push(text);
    } else if (!type.includes("user.message") && !type.includes("usage.")) {
      fallback.push(text);
    }
  }

  const combined = deltas.join("").trim() || fallback.join("\n").trim();
  return combined.replace(/\n{3,}/g, "\n\n");
}

function eventText(event) {
  const content = event.content ?? event.payload ?? event.data ?? event;
  return collectText(content).join("").trim();
}

function collectText(value, depth = 0) {
  if (depth > 5 || value == null) {
    return [];
  }
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value !== "object") {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectText(item, depth + 1));
  }

  const preferred = [];
  for (const key of ["text", "delta", "message", "summary", "output"]) {
    if (typeof value[key] === "string") {
      preferred.push(value[key]);
    }
  }
  if (preferred.length) {
    return preferred;
  }

  return Object.entries(value)
    .filter(([key]) => !["id", "type", "status", "occurredAt", "createdAt", "updatedAt"].includes(key))
    .flatMap(([, item]) => collectText(item, depth + 1));
}

function findThreadId(value) {
  if (!value || typeof value !== "object") {
    return "";
  }
  if (typeof value.threadId === "string") {
    return value.threadId;
  }
  if (value.thread && typeof value.thread.id === "string") {
    return value.thread.id;
  }
  if (typeof value.id === "string" && /^[0-9A-HJKMNP-TV-Z]{20,32}$/.test(value.id)) {
    return value.id;
  }
  for (const item of Object.values(value)) {
    const found = findThreadId(item);
    if (found) {
      return found;
    }
  }
  return "";
}

async function fetchMarketSnapshot() {
  const response = await fetch("https://stooq.com/q/l/?s=mu.us&f=sd2t2ohlcv&h&e=csv", {
    headers: { "User-Agent": "mosoo-stock-desk/0.1" }
  });
  const text = await response.text();
  const [headerLine, rowLine] = text.trim().split(/\r?\n/);
  if (!response.ok || !headerLine || !rowLine) {
    throw statusError(502, "market_source_failed", "无法获取 MU 行情快照。");
  }

  const headers = headerLine.split(",");
  const values = rowLine.split(",");
  const row = Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
  return {
    source: "stooq",
    delayed: true,
    symbol: row.Symbol || "MU.US",
    date: row.Date,
    time: row.Time,
    open: row.Open,
    high: row.High,
    low: row.Low,
    close: row.Close,
    volume: row.Volume
  };
}

async function fetchNewsSnapshot() {
  const response = await fetch("https://feeds.finance.yahoo.com/rss/2.0/headline?s=MU&region=US&lang=en-US", {
    headers: { "User-Agent": "mosoo-stock-desk/0.1" }
  });
  const xml = await response.text();
  if (!response.ok || !xml.includes("<item>")) {
    throw statusError(502, "news_source_failed", "无法获取 MU 新闻快照。");
  }

  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 8).map((match) => {
    const block = match[1];
    return {
      title: decodeXml(matchTag(block, "title")),
      link: decodeXml(matchTag(block, "link")),
      publishedAt: decodeXml(matchTag(block, "pubDate"))
    };
  });

  return {
    source: "yahoo-finance-rss",
    symbol: TICKER,
    items
  };
}

async function sendDecisionEmail(env, body) {
  const subject = String(body.subject || "MU 交易决策简报").slice(0, 180);
  const text = String(body.text || body.body || "").trim();
  const to = env.MAIL_TO || MAIL_TO;

  if (!text) {
    throw statusError(400, "missing_email_body", "缺少邮件正文。");
  }

  if (env.EMAIL_WEBHOOK_URL) {
    const response = await fetch(env.EMAIL_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.EMAIL_WEBHOOK_TOKEN ? { Authorization: `Bearer ${env.EMAIL_WEBHOOK_TOKEN}` } : {})
      },
      body: JSON.stringify({ to, subject, text })
    });
    return {
      ok: response.ok,
      provider: "webhook",
      status: response.status,
      message: response.ok ? `已提交到邮件 webhook: ${to}` : await response.text()
    };
  }

  if (env.RESEND_API_KEY) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: env.MAIL_FROM || "Mosoo Stock Desk <onboarding@resend.dev>",
        to,
        subject,
        text
      })
    });
    const data = await response.json().catch(() => ({}));
    return {
      ok: response.ok,
      provider: "resend",
      status: response.status,
      id: data.id || null,
      message: response.ok ? `已发送到 ${to}` : data.message || "Resend 发送失败。"
    };
  }

  return {
    ok: false,
    provider: "none",
    code: "email_not_configured",
    message: "未配置 RESEND_API_KEY 或 EMAIL_WEBHOOK_URL，已保留邮件草稿。"
  };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw statusError(400, "invalid_json", "请求体不是合法 JSON。");
  }
}

function parseJson(text) {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function statusError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function trimSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(String(value));
}

function matchTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? match[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "") : "";
}

function decodeXml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function renderHome() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mosoo MU Stock Desk</title>
  <script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>
  <style>
    :root {
      --bg: #f6f7f3;
      --panel: #ffffff;
      --ink: #161815;
      --muted: #667062;
      --line: #dce1d5;
      --green: #22784a;
      --amber: #9a6508;
      --red: #b2332f;
      --teal: #1f6f78;
      --shadow: 0 1px 2px rgba(22, 24, 21, .08);
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--ink);
      background: var(--bg);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }

    button, input, textarea, select { font: inherit; letter-spacing: 0; }
    button {
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--ink);
      min-height: 36px;
      padding: 0 10px;
      border-radius: 8px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      cursor: pointer;
      white-space: nowrap;
    }
    button.primary { background: var(--ink); color: #fff; border-color: var(--ink); }
    button.danger { color: var(--red); }
    button:disabled { opacity: .55; cursor: not-allowed; }
    svg { width: 17px; height: 17px; flex: 0 0 auto; }

    .shell {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr;
    }
    header {
      border-bottom: 1px solid var(--line);
      background: rgba(255,255,255,.86);
      backdrop-filter: blur(10px);
      position: sticky;
      top: 0;
      z-index: 3;
    }
    .topbar {
      max-width: 1440px;
      margin: 0 auto;
      padding: 14px 18px;
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: center;
      gap: 16px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }
    .mark {
      width: 42px;
      height: 42px;
      border: 1px solid #1f6f78;
      border-radius: 8px;
      display: grid;
      place-items: center;
      background: #ecf7f6;
      color: var(--teal);
      font-weight: 800;
    }
    h1 {
      margin: 0;
      font-size: 19px;
      line-height: 1.2;
    }
    .subline {
      margin-top: 3px;
      color: var(--muted);
      font-size: 13px;
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }

    main {
      width: min(1440px, 100%);
      margin: 0 auto;
      padding: 18px;
      display: grid;
      grid-template-columns: minmax(280px, 360px) 1fr;
      gap: 18px;
    }

    .sidebar, .workspace {
      min-width: 0;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }
    .panel-head {
      padding: 13px 14px;
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .panel-head h2, .agent-card h3 {
      margin: 0;
      font-size: 14px;
      line-height: 1.25;
    }
    .panel-body { padding: 14px; }

    .quote-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }
    .metric {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      min-height: 66px;
    }
    .metric small {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 8px;
    }
    .metric strong {
      display: block;
      font-size: 18px;
      overflow-wrap: anywhere;
    }
    .sparkline {
      width: 100%;
      height: 74px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background:
        linear-gradient(#eef2eb 1px, transparent 1px),
        linear-gradient(90deg, #eef2eb 1px, transparent 1px);
      background-size: 100% 24px, 25% 100%;
      margin-bottom: 14px;
    }
    .sparkline polyline { fill: none; stroke: var(--green); stroke-width: 3; }

    .risk-form {
      display: grid;
      gap: 10px;
    }
    label {
      display: grid;
      gap: 5px;
      color: var(--muted);
      font-size: 12px;
    }
    input, textarea, select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 9px 10px;
      background: #fff;
      color: var(--ink);
      outline: none;
    }
    textarea { min-height: 96px; resize: vertical; }

    .agent-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .agent-card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 13px;
      min-height: 174px;
      display: grid;
      grid-template-rows: auto auto 1fr;
      gap: 10px;
      box-shadow: var(--shadow);
    }
    .agent-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .dot {
      width: 9px;
      height: 9px;
      border-radius: 99px;
      background: #a4aa9f;
    }
    .dot.running { background: var(--amber); }
    .dot.ready { background: var(--green); }
    .dot.error { background: var(--red); }
    .mission {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }
    .output {
      min-height: 74px;
      max-height: 170px;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 13px;
      line-height: 1.5;
      color: #2c302a;
      border-top: 1px solid var(--line);
      padding-top: 10px;
    }

    .desk {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(280px, 420px);
      gap: 18px;
      align-items: start;
    }
    .tabs {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .tab.active { border-color: var(--ink); background: #f1f4ef; }
    .log {
      height: 440px;
      overflow: auto;
      padding: 14px;
      display: grid;
      gap: 10px;
      align-content: start;
    }
    .msg {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: #fff;
    }
    .msg.user { border-left: 4px solid var(--teal); }
    .msg.agent { border-left: 4px solid var(--green); }
    .msg.system { border-left: 4px solid var(--amber); }
    .msg strong {
      display: block;
      font-size: 12px;
      margin-bottom: 6px;
      color: var(--muted);
    }
    .msg div {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      line-height: 1.5;
      font-size: 13px;
    }
    .composer {
      border-top: 1px solid var(--line);
      padding: 12px;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
    }

    .memo {
      min-height: 440px;
      max-height: 560px;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 13px;
      line-height: 1.55;
      padding: 14px;
    }
    .notice {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }

    @media (max-width: 1080px) {
      main { grid-template-columns: 1fr; }
      .agent-grid, .desk { grid-template-columns: 1fr; }
    }
    @media (max-width: 640px) {
      .topbar { grid-template-columns: 1fr; }
      .actions { justify-content: flex-start; }
      main { padding: 12px; }
      .quote-grid { grid-template-columns: 1fr; }
      .composer { grid-template-columns: 1fr; }
      button { width: 100%; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div class="topbar">
        <div class="brand">
          <div class="mark">MU</div>
          <div>
            <h1>Mosoo MU Stock Desk</h1>
            <div class="subline">
              <span>Micron Technology</span>
              <span id="mailTarget">${MAIL_TO}</span>
              <span>Research only</span>
            </div>
          </div>
        </div>
        <div class="actions">
          <button id="refreshBtn" title="刷新行情"><i data-lucide="refresh-cw"></i><span>刷新</span></button>
          <button id="briefBtn" class="primary" title="运行三人组"><i data-lucide="play"></i><span>运行三人组</span></button>
          <button id="emailBtn" title="发送决策邮件"><i data-lucide="mail"></i><span>发邮件</span></button>
        </div>
      </div>
    </header>

    <main>
      <aside class="sidebar">
        <section class="panel">
          <div class="panel-head">
            <h2>MU 快照</h2>
            <span class="status"><span class="dot" id="quoteDot"></span><span id="quoteStatus">待刷新</span></span>
          </div>
          <div class="panel-body">
            <div class="quote-grid">
              <div class="metric"><small>Last</small><strong id="qClose">--</strong></div>
              <div class="metric"><small>Volume</small><strong id="qVolume">--</strong></div>
              <div class="metric"><small>High</small><strong id="qHigh">--</strong></div>
              <div class="metric"><small>Low</small><strong id="qLow">--</strong></div>
            </div>
            <svg class="sparkline" viewBox="0 0 360 74" role="img" aria-label="MU range">
              <polyline id="sparkline" points="12,54 70,46 128,38 186,42 244,28 302,31 348,22"></polyline>
            </svg>
            <div class="risk-form">
              <label>持仓股数 <input id="sharesInput" inputmode="decimal" value="0"></label>
              <label>成本价 <input id="costInput" inputmode="decimal" value=""></label>
              <label>风险预算 <input id="riskInput" value="单笔最大亏损 2%，不加杠杆"></label>
              <label>时间周期
                <select id="horizonInput">
                  <option>日内到 3 天</option>
                  <option>1 到 4 周</option>
                  <option>1 到 3 个月</option>
                </select>
              </label>
            </div>
          </div>
        </section>
      </aside>

      <section class="workspace">
        <div class="agent-grid" id="agentGrid"></div>
        <div class="desk">
          <section class="panel">
            <div class="panel-head">
              <div class="tabs" id="tabs"></div>
              <span class="status"><span class="dot ready"></span><span id="activeThread">Ready</span></span>
            </div>
            <div class="log" id="log"></div>
            <div class="composer">
              <textarea id="chatInput" placeholder="输入任务或问题"></textarea>
              <button id="sendBtn" class="primary" title="发送"><i data-lucide="send"></i><span>发送</span></button>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <h2>决策邮件</h2>
              <span class="status"><span class="dot" id="emailDot"></span><span id="emailStatus">未发送</span></span>
            </div>
            <div class="memo" id="memo">等待交易决策员输出。</div>
          </section>
        </div>
      </section>
    </main>
  </div>

  <script>
    const agents = ${JSON.stringify(AGENTS)};
    const state = {
      active: "market",
      quote: null,
      news: null,
      threads: JSON.parse(localStorage.getItem("mosoo-stock-threads") || "{}"),
      messages: JSON.parse(localStorage.getItem("mosoo-stock-messages") || "{}"),
      outputs: JSON.parse(localStorage.getItem("mosoo-stock-outputs") || "{}"),
      memo: localStorage.getItem("mosoo-stock-memo") || ""
    };

    const $ = (id) => document.getElementById(id);

    function save() {
      localStorage.setItem("mosoo-stock-threads", JSON.stringify(state.threads));
      localStorage.setItem("mosoo-stock-messages", JSON.stringify(state.messages));
      localStorage.setItem("mosoo-stock-outputs", JSON.stringify(state.outputs));
      localStorage.setItem("mosoo-stock-memo", state.memo || "");
    }

    function init() {
      renderAgents();
      renderTabs();
      renderLog();
      $("memo").textContent = state.memo || "等待交易决策员输出。";
      $("refreshBtn").addEventListener("click", refreshData);
      $("briefBtn").addEventListener("click", runBriefing);
      $("emailBtn").addEventListener("click", sendEmail);
      $("sendBtn").addEventListener("click", sendChat);
      $("chatInput").addEventListener("keydown", (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") sendChat();
      });
      refreshData();
      if (window.lucide) window.lucide.createIcons();
    }

    function renderAgents() {
      $("agentGrid").innerHTML = Object.values(agents).map((agent) => {
        const status = state.outputs[agent.key] ? "ready" : "idle";
        return '<article class="agent-card">' +
          '<div class="agent-title"><h3>' + agent.name + '</h3><span class="status"><span class="dot ' + (status === "ready" ? "ready" : "") + '" id="dot-' + agent.key + '"></span><span id="status-' + agent.key + '">' + (status === "ready" ? "已更新" : "待命") + '</span></span></div>' +
          '<div class="mission">' + agent.mission + '</div>' +
          '<div class="output" id="output-' + agent.key + '">' + escapeHtml(state.outputs[agent.key] || "暂无输出。") + '</div>' +
        '</article>';
      }).join("");
    }

    function renderTabs() {
      $("tabs").innerHTML = Object.values(agents).map((agent) =>
        '<button class="tab ' + (state.active === agent.key ? "active" : "") + '" data-agent="' + agent.key + '">' + agent.name + '</button>'
      ).join("");
      document.querySelectorAll(".tab").forEach((tab) => {
        tab.addEventListener("click", () => {
          state.active = tab.dataset.agent;
          renderTabs();
          renderLog();
        });
      });
    }

    function renderLog() {
      const agent = agents[state.active];
      const thread = state.threads[state.active] || "new";
      $("activeThread").textContent = agent.name + " / " + thread;
      const rows = state.messages[state.active] || [];
      $("log").innerHTML = rows.length ? rows.map((msg) =>
        '<div class="msg ' + msg.kind + '"><strong>' + msg.title + '</strong><div>' + escapeHtml(msg.text) + '</div></div>'
      ).join("") : '<div class="msg system"><strong>' + agent.name + '</strong><div>等待任务。</div></div>';
      $("log").scrollTop = $("log").scrollHeight;
    }

    async function refreshData() {
      setQuoteStatus("running", "刷新中");
      const [quoteResult, newsResult] = await Promise.allSettled([
        api("/api/market/mu"),
        api("/api/news/mu")
      ]);
      if (quoteResult.status === "fulfilled") {
        state.quote = quoteResult.value;
        $("qClose").textContent = fmt(quoteResult.value.close);
        $("qVolume").textContent = fmt(quoteResult.value.volume);
        $("qHigh").textContent = fmt(quoteResult.value.high);
        $("qLow").textContent = fmt(quoteResult.value.low);
        setQuoteStatus("ready", quoteResult.value.date || "已更新");
      } else {
        setQuoteStatus("error", "行情失败");
      }
      if (newsResult.status === "fulfilled") {
        state.news = newsResult.value;
      }
    }

    async function runBriefing() {
      $("briefBtn").disabled = true;
      setAgentStatus("market", "running", "盯盘中");
      setAgentStatus("news", "running", "收集中");
      addMessage("market", "system", "任务", "开始 MU 盯盘。");
      addMessage("news", "system", "任务", "开始信息面收集。");

      const context = buildContext();
      const marketPrompt = "请完成 MU 盯盘任务。输出：当前盘面、关键价位、成交量/波动、3 个触发条件、风险。\\n\\n" + context;
      const newsPrompt = "请完成 MU 信息面收集任务。输出：最新催化剂、负面风险、行业背景、需要继续验证的事实。\\n\\n" + context;

      const [market, news] = await Promise.all([
        sendToAgent("market", marketPrompt, 22000),
        sendToAgent("news", newsPrompt, 22000)
      ]);

      setAgentStatus("market", market.ok ? "ready" : "error", market.ok ? "已更新" : "失败");
      setAgentStatus("news", news.ok ? "ready" : "error", news.ok ? "已更新" : "失败");

      const decisionPrompt =
        "请作为交易决策员整合两位同事结论，只输出研究用途建议，不执行交易。需要包含：信号(BUY/SELL/HOLD)、置信度、仓位建议、止损/失效条件、主要理由、反方观点、发给 " + ${JSON.stringify(MAIL_TO)} + " 的中文邮件正文。\\n\\n" +
        "用户风险参数：\\n" + buildRiskProfile() + "\\n\\n" +
        "MU 盯盘员输出：\\n" + (state.outputs.market || "无") + "\\n\\n" +
        "信息面收集员输出：\\n" + (state.outputs.news || "无");

      setAgentStatus("decision", "running", "决策中");
      const decision = await sendToAgent("decision", decisionPrompt, 25000);
      setAgentStatus("decision", decision.ok ? "ready" : "error", decision.ok ? "已决策" : "失败");
      if (decision.ok) {
        state.memo = state.outputs.decision || "";
        $("memo").textContent = state.memo || "交易决策员没有返回正文。";
        save();
        await sendEmail();
      }
      $("briefBtn").disabled = false;
    }

    async function sendChat() {
      const text = $("chatInput").value.trim();
      if (!text) return;
      $("chatInput").value = "";
      setAgentStatus(state.active, "running", "工作中");
      addMessage(state.active, "user", "你", text);
      const result = await sendToAgent(state.active, text, 18000);
      setAgentStatus(state.active, result.ok ? "ready" : "error", result.ok ? "已回复" : "失败");
    }

    async function sendToAgent(agentKey, text, waitMs) {
      try {
        const data = await api("/api/agents/" + agentKey + "/message", {
          method: "POST",
          body: {
            text,
            waitMs,
            threadId: state.threads[agentKey] || ""
          }
        });
        state.threads[agentKey] = data.threadId;
        state.outputs[agentKey] = data.output || state.outputs[agentKey] || "";
        $("output-" + agentKey).textContent = state.outputs[agentKey] || "暂无输出。";
        addMessage(agentKey, "agent", agents[agentKey].name, data.output || "任务已提交，稍后刷新事件。");
        save();
        return { ok: true, data };
      } catch (error) {
        addMessage(agentKey, "system", "错误", error.message);
        save();
        return { ok: false, error };
      }
    }

    async function sendEmail() {
      const body = state.memo || state.outputs.decision || "";
      if (!body) {
        setEmailStatus("error", "无正文");
        return;
      }
      setEmailStatus("running", "发送中");
      try {
        const data = await api("/api/email", {
          method: "POST",
          body: {
            subject: "MU 交易决策简报",
            text: body
          }
        });
        setEmailStatus(data.ok ? "ready" : "error", data.message || "已处理");
      } catch (error) {
        setEmailStatus("error", error.message);
      }
    }

    function buildContext() {
      const quote = state.quote ? JSON.stringify(state.quote, null, 2) : "行情快照不可用";
      const news = state.news ? JSON.stringify(state.news, null, 2) : "新闻快照不可用";
      return "行情快照（可能延迟）：\\n" + quote + "\\n\\n新闻快照：\\n" + news + "\\n\\n风险参数：\\n" + buildRiskProfile();
    }

    function buildRiskProfile() {
      return [
        "持仓股数：" + $("sharesInput").value,
        "成本价：" + ($("costInput").value || "未填写"),
        "风险预算：" + $("riskInput").value,
        "时间周期：" + $("horizonInput").value
      ].join("\\n");
    }

    function addMessage(agentKey, kind, title, text) {
      state.messages[agentKey] = state.messages[agentKey] || [];
      state.messages[agentKey].push({ kind, title, text, at: new Date().toISOString() });
      if (state.messages[agentKey].length > 80) {
        state.messages[agentKey] = state.messages[agentKey].slice(-80);
      }
      if (state.active === agentKey) renderLog();
    }

    function setAgentStatus(agentKey, cls, text) {
      const dot = $("dot-" + agentKey);
      const label = $("status-" + agentKey);
      if (!dot || !label) return;
      dot.className = "dot " + cls;
      label.textContent = text;
    }

    function setQuoteStatus(cls, text) {
      $("quoteDot").className = "dot " + cls;
      $("quoteStatus").textContent = text;
    }

    function setEmailStatus(cls, text) {
      $("emailDot").className = "dot " + cls;
      $("emailStatus").textContent = text;
    }

    async function api(path, options = {}) {
      const response = await fetch(path, {
        method: options.method || "GET",
        headers: options.body ? { "Content-Type": "application/json" } : {},
        body: options.body ? JSON.stringify(options.body) : undefined
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.message || data.error || "请求失败");
      }
      return data;
    }

    function fmt(value) {
      if (!value || value === "N/D") return "--";
      const number = Number(value);
      return Number.isFinite(number) ? number.toLocaleString(undefined, { maximumFractionDigits: 2 }) : value;
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    init();
  </script>
</body>
</html>`;
}
