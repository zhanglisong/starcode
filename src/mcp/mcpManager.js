import path from "node:path";
import { spawn } from "node:child_process";

function interpolateEnv(value, env = process.env) {
  return String(value ?? "").replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => String(env[name] ?? ""));
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeEndpoint(endpoint) {
  return String(endpoint ?? "").replace(/\/+$/, "");
}

function withTimeoutAbort(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
    }
  };
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeToolDescriptor(tool) {
  if (!tool || typeof tool !== "object") {
    return null;
  }
  const name = String(tool.name ?? tool.id ?? "").trim();
  if (!name) {
    return null;
  }
  return {
    name,
    description: String(tool.description ?? ""),
    input_schema:
      tool.input_schema && typeof tool.input_schema === "object"
        ? tool.input_schema
        : tool.parameters && typeof tool.parameters === "object"
          ? tool.parameters
          : {
              type: "object",
              properties: {},
              additionalProperties: true
            }
  };
}

function normalizeResourceDescriptor(resource) {
  if (!resource || typeof resource !== "object") {
    return null;
  }
  const name = String(resource.name ?? resource.uri ?? "").trim();
  if (!name) {
    return null;
  }
  return {
    name,
    description: String(resource.description ?? ""),
    uri: String(resource.uri ?? "")
  };
}

function normalizePromptDescriptor(prompt) {
  if (!prompt || typeof prompt !== "object") {
    return null;
  }
  const name = String(prompt.name ?? "").trim();
  if (!name) {
    return null;
  }
  return {
    name,
    description: String(prompt.description ?? "")
  };
}

function normalizeMcpType(value) {
  const type = String(value ?? "http").toLowerCase();
  if (["http", "sse", "remote", "stdio"].includes(type)) {
    return type;
  }
  return "http";
}

function toEpochMs(value) {
  if (value === null || value === undefined || value === "") {
    return 0;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    if (numeric > 1e12) {
      return Math.round(numeric);
    }
    return Math.round(numeric * 1000);
  }
  const ts = Date.parse(String(value));
  return Number.isFinite(ts) ? ts : 0;
}

function isExpiredOAuth(oauth) {
  const expiresAt = toEpochMs(oauth?.expires_at);
  if (!expiresAt) {
    return false;
  }
  return Date.now() >= expiresAt;
}

function extractAuthUrl(response, payload, textBody = "") {
  const body = payload && typeof payload === "object" ? payload : {};
  const fromBody = String(body.authorization_url ?? body.auth_url ?? body.url ?? "").trim();
  if (fromBody) {
    return fromBody;
  }

  const fromHeader = String(response.headers?.get?.("x-authorization-url") ?? "").trim();
  if (fromHeader) {
    return fromHeader;
  }

  const matched = String(textBody).match(/https?:\/\/\S+/);
  return matched ? matched[0] : "";
}

function createNeedsAuthError({ url, status, payload, bodyText }) {
  const error = new Error(`mcp auth required: ${status}`);
  error.code = "mcp_needs_auth";
  error.status = status;
  error.authorization_url = extractAuthUrl(url, payload, bodyText);
  return error;
}

export function buildMcpToolName(serverId, toolName) {
  return `mcp__${serverId}__${toolName}`;
}

export function parseMcpToolName(name) {
  const match = String(name ?? "").match(/^mcp__([^_][^_]*)__([\s\S]+)$/);
  if (!match) {
    return null;
  }
  return {
    serverId: match[1],
    toolName: match[2]
  };
}

function buildServerHeaders(server, env) {
  const headers = {
    "content-type": "application/json"
  };
  const sourceHeaders = server.headers && typeof server.headers === "object" ? server.headers : {};

  for (const [name, value] of Object.entries(sourceHeaders)) {
    const normalized = interpolateEnv(value, env);
    if (!normalized) {
      continue;
    }
    headers[name.toLowerCase()] = normalized;
  }

  const oauthToken = String(server?.oauth?.access_token ?? "").trim();
  if (oauthToken && !isExpiredOAuth(server.oauth) && !headers.authorization) {
    headers.authorization = `Bearer ${oauthToken}`;
  }

  const apiKeyFromEnv = server.api_key_env ? String(env[server.api_key_env] ?? "") : "";
  const apiKey = interpolateEnv(server.api_key || apiKeyFromEnv || "", env);
  if (apiKey && !headers.authorization) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

async function fetchJson({ fetchImpl, url, method = "GET", headers = {}, body = undefined, timeoutMs = 8000 }) {
  const timeout = withTimeoutAbort(timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      headers,
      body,
      signal: timeout.signal
    });

    const textBody = await response.text();
    const payload = textBody ? safeJsonParse(textBody, null) : null;

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw createNeedsAuthError({
          url,
          status: response.status,
          payload,
          bodyText: textBody
        });
      }
      throw new Error(`mcp response ${response.status} from ${url}: ${textBody}`);
    }

    return payload ?? {};
  } finally {
    timeout.clear();
  }
}

async function fetchOptionalJson({ fetchImpl, url, headers = {}, timeoutMs = 8000 }) {
  try {
    return await fetchJson({
      fetchImpl,
      url,
      method: "GET",
      headers,
      timeoutMs
    });
  } catch (error) {
    if (String(error?.message ?? "").includes("mcp response 404")) {
      return null;
    }
    throw error;
  }
}

function normalizeServerConfig(server, env) {
  const type = normalizeMcpType(server?.type);
  return {
    id: String(server?.id ?? "").trim(),
    enabled: server?.enabled !== false,
    type,
    endpoint: normalizeEndpoint(server?.endpoint),
    command: String(server?.command ?? "").trim(),
    args: Array.isArray(server?.args) ? server.args.map((item) => String(item)) : [],
    environment: server?.environment && typeof server.environment === "object" ? server.environment : {},
    cwd: server?.cwd ? path.resolve(String(server.cwd)) : process.cwd(),
    version: String(server?.version ?? "v1"),
    headers: server?.headers && typeof server.headers === "object" ? server.headers : {},
    api_key: String(server?.api_key ?? ""),
    api_key_env: String(server?.api_key_env ?? ""),
    oauth: server?.oauth && typeof server.oauth === "object" ? server.oauth : {},
    env
  };
}

async function invokeStdioRpc(server, request, timeoutMs) {
  const command = server.command;
  if (!command) {
    throw new Error(`stdio mcp server '${server.id}' is missing command`);
  }

  const args = Array.isArray(server.args) ? server.args : [];
  const childEnv = {
    ...process.env,
    ...(server.environment || {})
  };

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: server.cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`mcp stdio timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);

      const stdoutText = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();

      if (code !== 0) {
        reject(new Error(`mcp stdio process exited with code ${code}: ${stderrText}`));
        return;
      }

      if (!stdoutText) {
        reject(new Error(`mcp stdio process returned empty output: ${stderrText}`));
        return;
      }

      const lines = stdoutText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const lastLine = lines.at(-1) ?? "";
      const parsed = safeJsonParse(lastLine, null);
      if (!parsed) {
        reject(new Error(`mcp stdio returned non-json response: ${lastLine}`));
        return;
      }

      resolve(parsed);
    });

    child.stdin.write(`${JSON.stringify(request)}\n`);
    child.stdin.end();
  });
}

export class McpManager {
  constructor({ servers = [], env = process.env, fetchImpl = fetch, timeoutMs = 8000, cacheTtlMs = 5000 } = {}) {
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : 8000;
    this.cacheTtlMs = Number.isFinite(cacheTtlMs) ? cacheTtlMs : 5000;
    this.servers = (Array.isArray(servers) ? servers : []).map((server) => normalizeServerConfig(server, env)).filter((server) => server.id);
    this.cache = null;
    this.statuses = {};
    for (const server of this.servers) {
      this.statuses[server.id] = {
        status: server.enabled ? "failed" : "disabled",
        updated_at: nowIso(),
        reason: server.enabled ? "not_initialized" : "disabled"
      };
    }
  }

  isEnabled() {
    return this.servers.some((server) => server.enabled !== false);
  }

  getStatusSnapshot() {
    return JSON.parse(JSON.stringify(this.statuses));
  }

  setStatus(serverId, status) {
    this.statuses[serverId] = {
      ...status,
      updated_at: nowIso()
    };
  }

  async discoverHttpLike(server) {
    const headers = buildServerHeaders(server, this.env);
    const endpoint = server.endpoint;
    if (!endpoint) {
      throw new Error(`mcp server '${server.id}' is missing endpoint`);
    }

    const toolsPayload = await fetchJson({
      fetchImpl: this.fetchImpl,
      url: `${endpoint}/tools`,
      method: "GET",
      headers,
      timeoutMs: this.timeoutMs
    });
    const resourcesPayload = await fetchOptionalJson({
      fetchImpl: this.fetchImpl,
      url: `${endpoint}/resources`,
      headers,
      timeoutMs: this.timeoutMs
    });
    const promptsPayload = await fetchOptionalJson({
      fetchImpl: this.fetchImpl,
      url: `${endpoint}/prompts`,
      headers,
      timeoutMs: this.timeoutMs
    });

    const tools = (Array.isArray(toolsPayload?.tools) ? toolsPayload.tools : Array.isArray(toolsPayload) ? toolsPayload : [])
      .map(normalizeToolDescriptor)
      .filter(Boolean);
    const resources = (
      Array.isArray(resourcesPayload?.resources) ? resourcesPayload.resources : Array.isArray(resourcesPayload) ? resourcesPayload : []
    )
      .map(normalizeResourceDescriptor)
      .filter(Boolean);
    const prompts = (Array.isArray(promptsPayload?.prompts) ? promptsPayload.prompts : Array.isArray(promptsPayload) ? promptsPayload : [])
      .map(normalizePromptDescriptor)
      .filter(Boolean);

    return {
      id: server.id,
      endpoint,
      type: server.type,
      version: String(toolsPayload?.version ?? server.version ?? "v1"),
      tools,
      resources,
      prompts
    };
  }

  async discoverStdio(server) {
    const payload = await invokeStdioRpc(
      server,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "discover",
        params: {}
      },
      this.timeoutMs
    );

    const body = payload?.result && typeof payload.result === "object" ? payload.result : payload;
    const tools = (Array.isArray(body?.tools) ? body.tools : []).map(normalizeToolDescriptor).filter(Boolean);
    const resources = (Array.isArray(body?.resources) ? body.resources : []).map(normalizeResourceDescriptor).filter(Boolean);
    const prompts = (Array.isArray(body?.prompts) ? body.prompts : []).map(normalizePromptDescriptor).filter(Boolean);

    return {
      id: server.id,
      endpoint: "",
      type: "stdio",
      version: String(body?.version ?? server.version ?? "v1"),
      tools,
      resources,
      prompts
    };
  }

  async discoverServer(server) {
    if (server.enabled === false) {
      this.setStatus(server.id, {
        status: "disabled"
      });
      return null;
    }

    try {
      let result;
      if (server.type === "stdio") {
        result = await this.discoverStdio(server);
      } else {
        result = await this.discoverHttpLike(server);
      }

      this.setStatus(server.id, {
        status: "connected"
      });
      return result;
    } catch (error) {
      if (error?.code === "mcp_needs_auth") {
        this.setStatus(server.id, {
          status: "needs_auth",
          error: error.message,
          authorization_url: error.authorization_url || ""
        });
      } else {
        this.setStatus(server.id, {
          status: "failed",
          error: error.message
        });
      }
      throw error;
    }
  }

  async discover({ force = false } = {}) {
    const now = Date.now();
    if (!force && this.cache && now - this.cache.at < this.cacheTtlMs) {
      return this.cache.data;
    }

    const servers = [];
    const errors = [];

    for (const server of this.servers) {
      try {
        const discovered = await this.discoverServer(server);
        if (discovered) {
          servers.push(discovered);
        }
      } catch (error) {
        errors.push({
          id: server.id,
          type: server.type,
          endpoint: server.endpoint,
          status: this.statuses[server.id]?.status ?? "failed",
          authorization_url: this.statuses[server.id]?.authorization_url ?? "",
          error: error.message
        });
      }
    }

    const toolDefinitions = [];
    for (const server of servers) {
      for (const tool of server.tools) {
        toolDefinitions.push({
          type: "function",
          function: {
            name: buildMcpToolName(server.id, tool.name),
            description: `[mcp:${server.id}@${server.version}] ${tool.description}`.trim(),
            parameters: tool.input_schema
          }
        });
      }
    }

    const contextLines = [];
    for (const server of servers) {
      contextLines.push(
        `- server ${server.id}@${server.version} (${server.type}): tools=${server.tools.length} resources=${server.resources.length} prompts=${server.prompts.length}`
      );
      if (server.resources.length) {
        contextLines.push(`  resources: ${server.resources.map((item) => item.name).slice(0, 8).join(", ")}`);
      }
      if (server.prompts.length) {
        contextLines.push(`  prompts: ${server.prompts.map((item) => item.name).slice(0, 8).join(", ")}`);
      }
    }

    const data = {
      servers,
      errors,
      statuses: this.getStatusSnapshot(),
      toolDefinitions,
      contextText: contextLines.length ? `MCP Runtime Context:\n${contextLines.join("\n")}` : ""
    };

    this.cache = {
      at: now,
      data
    };

    return data;
  }

  findServer(serverId) {
    const server = this.servers.find((item) => item.id === serverId);
    if (!server) {
      throw new Error(`mcp server not found: ${serverId}`);
    }
    if (server.enabled === false) {
      throw new Error(`mcp server disabled: ${serverId}`);
    }
    return server;
  }

  async executeToolHttpLike(server, { toolName, argumentsObject }) {
    const headers = buildServerHeaders(server, this.env);
    const payload = await fetchJson({
      fetchImpl: this.fetchImpl,
      url: `${server.endpoint}/tools/execute`,
      method: "POST",
      headers,
      body: JSON.stringify({
        name: toolName,
        arguments: argumentsObject
      }),
      timeoutMs: this.timeoutMs
    });

    return payload?.result ?? payload;
  }

  async executeToolStdio(server, { toolName, argumentsObject }) {
    const payload = await invokeStdioRpc(
      server,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "call_tool",
        params: {
          name: toolName,
          arguments: argumentsObject
        }
      },
      this.timeoutMs
    );

    const body = payload?.result && typeof payload.result === "object" ? payload.result : payload;
    return body?.result ?? body;
  }

  async executeTool({ serverId, toolName, argumentsObject }) {
    const server = this.findServer(serverId);

    let result;
    if (server.type === "stdio") {
      result = await this.executeToolStdio(server, { toolName, argumentsObject });
    } else {
      result = await this.executeToolHttpLike(server, { toolName, argumentsObject });
    }

    const discovery = await this.discover();
    const discoveredServer = discovery.servers.find((item) => item.id === serverId);
    const version = discoveredServer?.version ?? server.version ?? "v1";

    return {
      result,
      meta: {
        mcp_server_id: serverId,
        mcp_server_version: version,
        mcp_tool_name: toolName
      }
    };
  }

  async executeToolCall(call) {
    const tool = parseMcpToolName(call?.function?.name);
    if (!tool) {
      throw new Error(`not an mcp tool call: ${call?.function?.name ?? "unknown"}`);
    }

    const args = safeJsonParse(call?.function?.arguments ?? "{}", {});
    return this.executeTool({
      serverId: tool.serverId,
      toolName: tool.toolName,
      argumentsObject: args
    });
  }
}
