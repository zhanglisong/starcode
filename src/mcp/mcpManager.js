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

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`mcp response ${response.status} from ${url}: ${detail}`);
    }

    return await response.json();
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
    if (/mcp response 404/.test(error.message)) {
      return null;
    }
    throw error;
  }
}

export class McpManager {
  constructor({ servers = [], env = process.env, fetchImpl = fetch, timeoutMs = 8000, cacheTtlMs = 5000 } = {}) {
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : 8000;
    this.cacheTtlMs = Number.isFinite(cacheTtlMs) ? cacheTtlMs : 5000;
    this.servers = (Array.isArray(servers) ? servers : [])
      .filter((server) => server?.enabled !== false)
      .map((server) => ({
        id: String(server.id ?? "").trim(),
        type: String(server.type ?? "http").toLowerCase(),
        endpoint: normalizeEndpoint(server.endpoint),
        version: String(server.version ?? "v1"),
        headers: server.headers && typeof server.headers === "object" ? server.headers : {},
        api_key: String(server.api_key ?? ""),
        api_key_env: String(server.api_key_env ?? "")
      }))
      .filter((server) => server.id && server.endpoint);
    this.cache = null;
  }

  isEnabled() {
    return this.servers.length > 0;
  }

  async discoverServer(server) {
    if (server.type !== "http") {
      throw new Error(`unsupported mcp server type '${server.type}'`);
    }

    const headers = buildServerHeaders(server, this.env);
    const toolsPayload = await fetchJson({
      fetchImpl: this.fetchImpl,
      url: `${server.endpoint}/tools`,
      method: "GET",
      headers,
      timeoutMs: this.timeoutMs
    });
    const resourcesPayload = await fetchOptionalJson({
      fetchImpl: this.fetchImpl,
      url: `${server.endpoint}/resources`,
      headers,
      timeoutMs: this.timeoutMs
    });
    const promptsPayload = await fetchOptionalJson({
      fetchImpl: this.fetchImpl,
      url: `${server.endpoint}/prompts`,
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
      endpoint: server.endpoint,
      version: String(toolsPayload?.version ?? server.version ?? "v1"),
      tools,
      resources,
      prompts
    };
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
        servers.push(discovered);
      } catch (error) {
        errors.push({
          id: server.id,
          endpoint: server.endpoint,
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
      contextLines.push(`- server ${server.id}@${server.version}: tools=${server.tools.length} resources=${server.resources.length} prompts=${server.prompts.length}`);
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
      toolDefinitions,
      contextText: contextLines.length ? `MCP Runtime Context:\n${contextLines.join("\n")}` : ""
    };
    this.cache = {
      at: now,
      data
    };
    return data;
  }

  async executeTool({ serverId, toolName, argumentsObject }) {
    const server = this.servers.find((item) => item.id === serverId);
    if (!server) {
      throw new Error(`mcp server not found: ${serverId}`);
    }

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

    const discovery = await this.discover();
    const discoveredServer = discovery.servers.find((item) => item.id === serverId);
    const version = discoveredServer?.version ?? server.version ?? "v1";

    return {
      result: payload?.result ?? payload,
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
