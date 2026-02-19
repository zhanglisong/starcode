import { DEFAULT_ENDPOINTS, normalizeProviderName, resolveEndpoint } from "../providers/openAICompatibleProvider.js";
import { listProviderModels } from "../providers/modelCatalog.js";
import { loadProfiles, maskSecret, saveProfiles } from "./profileStore.js";

function parseArgs(args) {
  const positionals = [];
  const flags = {};

  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i] ?? "");
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = String(args[i + 1] ?? "");
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }

  return {
    positionals,
    flags
  };
}

function parseHeaderPairs(value) {
  if (typeof value !== "string" || !value.trim()) {
    return {};
  }

  const headers = {};
  for (const token of value.split(",")) {
    const pair = token.trim();
    if (!pair) {
      continue;
    }
    const idx = pair.indexOf(":");
    if (idx <= 0) {
      continue;
    }
    const name = pair.slice(0, idx).trim();
    const headerValue = pair.slice(idx + 1).trim();
    if (!name || !headerValue) {
      continue;
    }
    headers[name] = headerValue;
  }
  return headers;
}

function parseEnvPairs(value) {
  if (typeof value !== "string" || !value.trim()) {
    return {};
  }

  const env = {};
  for (const token of value.split(",")) {
    const pair = token.trim();
    if (!pair) {
      continue;
    }
    const idx = pair.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const key = pair.slice(0, idx).trim();
    const itemValue = pair.slice(idx + 1).trim();
    if (!key) {
      continue;
    }
    env[key] = itemValue;
  }
  return env;
}

function parseCommandArgs(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  const text = String(value ?? "").trim();
  if (!text) {
    return [];
  }
  if (text.startsWith("[") && text.endsWith("]")) {
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
    } catch {
      return [];
    }
  }
  return text
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveProvider(value) {
  return normalizeProviderName(String(value ?? "").toLowerCase() || "openai-compatible");
}

function lookupApiKeyFromEnv(provider, env) {
  const candidates = {
    moonshot: ["KIMI_API_KEY", "MOONSHOT_API_KEY", "MODEL_API_KEY"],
    openai: ["OPENAI_API_KEY", "MODEL_API_KEY"],
    "openai-compatible": ["OPENAI_API_KEY", "MODEL_API_KEY"],
    ollama: ["MODEL_API_KEY"]
  }[provider] ?? ["MODEL_API_KEY"];

  for (const name of candidates) {
    const value = String(env[name] ?? "").trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function print(output, line) {
  output.write(`${line}\n`);
}

function parseProviderFromArgs(positionals, fallback = "") {
  return resolveProvider(positionals[0] ?? fallback ?? "");
}

function normalizeMcpType(value) {
  const type = String(value ?? "http").trim().toLowerCase();
  if (["http", "sse", "stdio", "remote"].includes(type)) {
    return type;
  }
  return "http";
}

function nowIso() {
  return new Date().toISOString();
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
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isExpiredAuth(auth) {
  const expiresAt = toEpochMs(auth?.expires_at);
  if (!expiresAt) {
    return false;
  }
  return Date.now() >= expiresAt;
}

export async function resolveRuntimeModelConfig({ env = process.env, storePath = "" } = {}) {
  const { data } = await loadProfiles(storePath);
  const provider = resolveProvider(env.MODEL_PROVIDER ?? data.defaults.provider ?? "mock");
  const saved = data.auth?.[provider] ?? {};
  const model = String(env.MODEL_NAME ?? data.defaults.model ?? "gpt-4.1-mini");
  const endpoint = env.MODEL_ENDPOINT ?? saved.endpoint ?? resolveEndpoint(provider);
  const apiKey = env.MODEL_API_KEY ?? saved.api_key ?? lookupApiKeyFromEnv(provider, env);

  return {
    provider,
    model,
    endpoint,
    apiKey
  };
}

export async function resolveRuntimeMcpConfig({ env = process.env, storePath = "" } = {}) {
  const { data } = await loadProfiles(storePath);
  const authMap = data?.mcp?.auth && typeof data.mcp.auth === "object" ? data.mcp.auth : {};

  const servers = Object.entries(data?.mcp?.servers ?? {})
    .map(([id, server]) => {
      const auth = authMap[id] && typeof authMap[id] === "object" ? authMap[id] : {};
      return {
        id,
        enabled: server?.enabled !== false,
        type: normalizeMcpType(server?.type),
        endpoint: String(server?.endpoint ?? ""),
        command: String(server?.command ?? ""),
        args: Array.isArray(server?.args) ? server.args.map((item) => String(item)) : [],
        environment: server?.environment && typeof server.environment === "object" ? server.environment : {},
        version: String(server?.version ?? "v1"),
        api_key: String(server?.api_key ?? ""),
        api_key_env: String(server?.api_key_env ?? ""),
        headers: server?.headers && typeof server.headers === "object" ? server.headers : {},
        oauth: auth
      };
    })
    .filter((server) => {
      if (!server.enabled) {
        return false;
      }
      if (server.type === "stdio") {
        return Boolean(server.command);
      }
      return Boolean(server.endpoint);
    });

  if (env.STARCODE_MCP_DISABLE === "true") {
    return { servers: [] };
  }

  return { servers };
}

async function handleAuthLogin(args, { output, env, storePath }) {
  const { positionals, flags } = parseArgs(args);
  const provider = parseProviderFromArgs(positionals, env.MODEL_PROVIDER);
  const { path: resolvedPath, data } = await loadProfiles(storePath);

  const previous = data.auth?.[provider] ?? {};
  const endpoint = String(flags.endpoint ?? env.MODEL_ENDPOINT ?? previous.endpoint ?? resolveEndpoint(provider));
  const apiKey = String(flags["api-key"] ?? lookupApiKeyFromEnv(provider, env) ?? previous.api_key ?? "");

  if (provider !== "ollama" && !apiKey) {
    throw new Error(
      `Missing API key for provider '${provider}'. Pass --api-key or set one of: MODEL_API_KEY, OPENAI_API_KEY, KIMI_API_KEY.`
    );
  }

  data.auth[provider] = {
    endpoint,
    api_key: apiKey
  };
  data.defaults.provider = provider;

  if (flags.model && typeof flags.model === "string") {
    data.defaults.model = flags.model;
  }

  await saveProfiles(data, resolvedPath);

  print(output, `auth login ok provider=${provider}`);
  print(output, `endpoint=${endpoint}`);
  print(output, `api_key=${apiKey ? maskSecret(apiKey) : "(empty)"}`);
  print(output, `profile_path=${resolvedPath}`);
}

async function handleAuthLogout(args, { output, storePath }) {
  const { positionals, flags } = parseArgs(args);
  const { path: resolvedPath, data } = await loadProfiles(storePath);

  if (flags.all) {
    data.auth = {};
    data.defaults.provider = "";
    data.defaults.model = "";
    await saveProfiles(data, resolvedPath);
    print(output, "auth logout ok provider=all");
    print(output, `profile_path=${resolvedPath}`);
    return;
  }

  const provider = parseProviderFromArgs(positionals, data.defaults.provider);
  if (!provider || !data.auth?.[provider]) {
    throw new Error(`No stored credentials found for provider '${provider || "unknown"}'.`);
  }

  delete data.auth[provider];
  if (data.defaults.provider === provider) {
    data.defaults.provider = "";
    data.defaults.model = "";
  }
  await saveProfiles(data, resolvedPath);

  print(output, `auth logout ok provider=${provider}`);
  print(output, `profile_path=${resolvedPath}`);
}

async function handleAuthList({ output, storePath }) {
  const { path: resolvedPath, data } = await loadProfiles(storePath);
  const providers = Object.entries(data.auth ?? {}).sort((a, b) => a[0].localeCompare(b[0]));

  print(output, `profile_path=${resolvedPath}`);
  print(output, `defaults provider=${data.defaults.provider || "(none)"} model=${data.defaults.model || "(none)"}`);

  if (!providers.length) {
    print(output, "providers=(none)");
    return;
  }

  for (const [provider, config] of providers) {
    const endpoint = config?.endpoint ?? DEFAULT_ENDPOINTS[provider] ?? "";
    const key = config?.api_key ?? "";
    print(output, `- ${provider} endpoint=${endpoint} api_key=${key ? maskSecret(key) : "(empty)"}`);
  }
}

export async function runAuthCommand(args, options) {
  const [subcommand = "list", ...rest] = args;
  const normalized = String(subcommand).toLowerCase();

  if (normalized === "list") {
    await handleAuthList(options);
    return;
  }

  if (normalized === "login") {
    await handleAuthLogin(rest, options);
    return;
  }

  if (normalized === "logout") {
    await handleAuthLogout(rest, options);
    return;
  }

  throw new Error(`Unknown auth subcommand '${subcommand}'. Use: login | logout | list`);
}

async function handleModelsList(args, { output, env, storePath, fetchImpl }) {
  const { positionals, flags } = parseArgs(args);
  const runtime = await resolveRuntimeModelConfig({ env, storePath });
  const provider = parseProviderFromArgs(positionals, flags.provider ?? runtime.provider);
  const endpoint = String(flags.endpoint ?? runtime.endpoint ?? resolveEndpoint(provider));
  const apiKey = String(flags["api-key"] ?? runtime.apiKey ?? "");

  const catalog = await listProviderModels({
    providerName: provider,
    endpoint,
    apiKey,
    fetchImpl
  });

  print(output, `provider=${catalog.provider}`);
  print(output, `endpoint=${catalog.endpoint}`);
  print(output, `models=${catalog.models.length}`);

  const selectedModel = String(runtime.model ?? "");
  for (const modelId of catalog.models) {
    const marker = modelId === selectedModel ? "*" : " ";
    print(output, `${marker} ${modelId}`);
  }
}

async function handleModelsUse(args, { output, env, storePath }) {
  const { positionals, flags } = parseArgs(args);
  const model = String(positionals[0] ?? "").trim();
  if (!model) {
    throw new Error("Missing model id. Usage: starcode models use <model_id> [--provider <provider>]");
  }

  const { path: resolvedPath, data } = await loadProfiles(storePath);
  const runtime = await resolveRuntimeModelConfig({ env, storePath: resolvedPath });
  const provider = parseProviderFromArgs([], flags.provider ?? runtime.provider);

  data.defaults.provider = provider;
  data.defaults.model = model;
  await saveProfiles(data, resolvedPath);

  print(output, `models use ok provider=${provider} model=${model}`);
  print(output, `profile_path=${resolvedPath}`);
}

export async function runModelsCommand(args, options) {
  const [subcommand = "list", ...rest] = args;
  const normalized = String(subcommand).toLowerCase();

  if (normalized === "list") {
    await handleModelsList(rest, options);
    return;
  }

  if (normalized === "use") {
    await handleModelsUse(rest, options);
    return;
  }

  throw new Error(`Unknown models subcommand '${subcommand}'. Use: list | use`);
}

async function handleMcpList({ output, storePath }) {
  const { path: resolvedPath, data } = await loadProfiles(storePath);
  const servers = Object.entries(data?.mcp?.servers ?? {}).sort((a, b) => a[0].localeCompare(b[0]));

  print(output, `profile_path=${resolvedPath}`);
  print(output, `mcp_servers=${servers.length}`);

  if (!servers.length) {
    print(output, "servers=(none)");
    return;
  }

  for (const [id, server] of servers) {
    const type = normalizeMcpType(server?.type);
    const endpoint = String(server?.endpoint ?? "");
    const command = String(server?.command ?? "");
    const location = type === "stdio" ? `command=${command}` : `endpoint=${endpoint}`;
    print(
      output,
      `- ${id} enabled=${server?.enabled !== false} type=${type} ${location} version=${server?.version ?? "v1"}`
    );
  }
}

async function handleMcpAdd(args, { output, storePath }) {
  const { positionals, flags } = parseArgs(args);
  const id = String(positionals[0] ?? "").trim();
  if (!id) {
    throw new Error("Missing MCP server id. Usage: starcode mcp add <id> --endpoint <url>");
  }

  const { path: resolvedPath, data } = await loadProfiles(storePath);
  const previous = data?.mcp?.servers?.[id] ?? {};
  const type = normalizeMcpType(flags.type ?? previous.type ?? "http");

  let endpoint = String(flags.endpoint ?? previous.endpoint ?? "").trim();
  const command = String(flags.command ?? previous.command ?? "").trim();
  const argsList = flags.args !== undefined ? parseCommandArgs(flags.args) : Array.isArray(previous.args) ? previous.args : [];
  const environment = {
    ...(previous.environment && typeof previous.environment === "object" ? previous.environment : {}),
    ...parseEnvPairs(String(flags.env ?? ""))
  };

  if (type === "stdio") {
    if (!command) {
      throw new Error("Missing --command for stdio MCP server.");
    }
    endpoint = "";
  } else if (!endpoint) {
    throw new Error("Missing --endpoint for MCP server.");
  }

  const headers = {
    ...(previous.headers && typeof previous.headers === "object" ? previous.headers : {}),
    ...parseHeaderPairs(String(flags.header ?? ""))
  };

  data.mcp = data.mcp && typeof data.mcp === "object" ? data.mcp : { servers: {}, auth: {} };
  data.mcp.servers = data.mcp.servers && typeof data.mcp.servers === "object" ? data.mcp.servers : {};
  data.mcp.auth = data.mcp.auth && typeof data.mcp.auth === "object" ? data.mcp.auth : {};

  data.mcp.servers[id] = {
    id,
    type,
    endpoint,
    command,
    args: argsList,
    environment,
    enabled: flags.disabled ? false : true,
    version: String(flags.version ?? previous.version ?? "v1"),
    api_key: String(flags["api-key"] ?? previous.api_key ?? ""),
    api_key_env: String(flags["api-key-env"] ?? previous.api_key_env ?? ""),
    headers
  };

  await saveProfiles(data, resolvedPath);

  print(output, `mcp add ok id=${id}`);
  if (type === "stdio") {
    print(output, `command=${command}`);
  } else {
    print(output, `endpoint=${endpoint}`);
  }
  print(output, `enabled=${data.mcp.servers[id].enabled}`);
  print(output, `profile_path=${resolvedPath}`);
}

async function handleMcpRemove(args, { output, storePath }) {
  const { positionals } = parseArgs(args);
  const id = String(positionals[0] ?? "").trim();
  if (!id) {
    throw new Error("Missing MCP server id. Usage: starcode mcp remove <id>");
  }

  const { path: resolvedPath, data } = await loadProfiles(storePath);
  if (!data?.mcp?.servers?.[id]) {
    throw new Error(`MCP server '${id}' not found.`);
  }

  delete data.mcp.servers[id];
  if (data?.mcp?.auth?.[id]) {
    delete data.mcp.auth[id];
  }
  await saveProfiles(data, resolvedPath);
  print(output, `mcp remove ok id=${id}`);
  print(output, `profile_path=${resolvedPath}`);
}

async function handleMcpToggle(args, { output, storePath }, enabled) {
  const { positionals } = parseArgs(args);
  const id = String(positionals[0] ?? "").trim();
  if (!id) {
    throw new Error(`Missing MCP server id. Usage: starcode mcp ${enabled ? "enable" : "disable"} <id>`);
  }

  const { path: resolvedPath, data } = await loadProfiles(storePath);
  if (!data?.mcp?.servers?.[id]) {
    throw new Error(`MCP server '${id}' not found.`);
  }

  data.mcp.servers[id].enabled = enabled;
  await saveProfiles(data, resolvedPath);
  print(output, `mcp ${enabled ? "enable" : "disable"} ok id=${id}`);
  print(output, `profile_path=${resolvedPath}`);
}

async function handleMcpAuthStatus(args, { output, storePath }) {
  const { positionals } = parseArgs(args);
  const id = String(positionals[0] ?? "").trim();
  if (!id) {
    throw new Error("Missing MCP server id. Usage: starcode mcp auth status <id>");
  }

  const { data } = await loadProfiles(storePath);
  const auth = data?.mcp?.auth?.[id] ?? null;
  const status = !auth
    ? "not_authenticated"
    : isExpiredAuth(auth)
      ? "expired"
      : auth.access_token
        ? "authenticated"
        : "not_authenticated";

  print(output, `mcp auth status id=${id} status=${status}`);
  print(output, `has_access_token=${Boolean(auth?.access_token)}`);
  print(output, `expires_at=${auth?.expires_at ?? ""}`);
}

async function handleMcpAuthClear(args, { output, storePath }) {
  const { positionals } = parseArgs(args);
  const id = String(positionals[0] ?? "").trim();
  if (!id) {
    throw new Error("Missing MCP server id. Usage: starcode mcp auth clear <id>");
  }

  const { path: resolvedPath, data } = await loadProfiles(storePath);
  data.mcp = data.mcp && typeof data.mcp === "object" ? data.mcp : { servers: {}, auth: {} };
  data.mcp.auth = data.mcp.auth && typeof data.mcp.auth === "object" ? data.mcp.auth : {};
  delete data.mcp.auth[id];
  await saveProfiles(data, resolvedPath);

  print(output, `mcp auth clear ok id=${id}`);
  print(output, `profile_path=${resolvedPath}`);
}

async function handleMcpAuthStart(args, { output, storePath, fetchImpl }) {
  const { positionals } = parseArgs(args);
  const id = String(positionals[0] ?? "").trim();
  if (!id) {
    throw new Error("Missing MCP server id. Usage: starcode mcp auth start <id>");
  }

  const { path: resolvedPath, data } = await loadProfiles(storePath);
  const server = data?.mcp?.servers?.[id];
  if (!server) {
    throw new Error(`MCP server '${id}' not found.`);
  }

  const endpoint = String(server.endpoint ?? "").trim();
  if (!endpoint) {
    throw new Error(`MCP server '${id}' has no endpoint for auth flow.`);
  }

  const response = await fetchImpl(`${endpoint.replace(/\/+$/, "")}/oauth/start`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ server_id: id })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`mcp auth start failed: ${response.status} ${detail}`);
  }

  const payload = await response.json();
  const authorizationUrl = String(payload?.authorization_url ?? payload?.url ?? "").trim();
  const state = String(payload?.state ?? "").trim();

  if (!authorizationUrl) {
    throw new Error("mcp auth start failed: missing authorization_url");
  }

  data.mcp = data.mcp && typeof data.mcp === "object" ? data.mcp : { servers: {}, auth: {} };
  data.mcp.auth = data.mcp.auth && typeof data.mcp.auth === "object" ? data.mcp.auth : {};
  const previous = data.mcp.auth[id] && typeof data.mcp.auth[id] === "object" ? data.mcp.auth[id] : {};
  data.mcp.auth[id] = {
    ...previous,
    authorization_url: authorizationUrl,
    pending_state: state,
    updated_at: nowIso()
  };

  await saveProfiles(data, resolvedPath);

  print(output, `mcp auth start ok id=${id}`);
  print(output, `authorization_url=${authorizationUrl}`);
  if (state) {
    print(output, `state=${state}`);
  }
  print(output, `profile_path=${resolvedPath}`);
}

async function handleMcpAuthFinish(args, { output, storePath, fetchImpl }) {
  const { positionals, flags } = parseArgs(args);
  const id = String(positionals[0] ?? "").trim();
  if (!id) {
    throw new Error("Missing MCP server id. Usage: starcode mcp auth finish <id> --code <code>");
  }

  const code = String(flags.code ?? "").trim();
  if (!code) {
    throw new Error("Missing --code for MCP auth finish.");
  }

  const { path: resolvedPath, data } = await loadProfiles(storePath);
  const server = data?.mcp?.servers?.[id];
  if (!server) {
    throw new Error(`MCP server '${id}' not found.`);
  }

  const endpoint = String(server.endpoint ?? "").trim();
  if (!endpoint) {
    throw new Error(`MCP server '${id}' has no endpoint for auth flow.`);
  }

  data.mcp = data.mcp && typeof data.mcp === "object" ? data.mcp : { servers: {}, auth: {} };
  data.mcp.auth = data.mcp.auth && typeof data.mcp.auth === "object" ? data.mcp.auth : {};
  const previous = data.mcp.auth[id] && typeof data.mcp.auth[id] === "object" ? data.mcp.auth[id] : {};
  const state = String(flags.state ?? previous.pending_state ?? "").trim();

  const response = await fetchImpl(`${endpoint.replace(/\/+$/, "")}/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      code,
      state
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`mcp auth finish failed: ${response.status} ${detail}`);
  }

  const payload = await response.json();
  const accessToken = String(payload?.access_token ?? payload?.token ?? "").trim();
  const refreshToken = String(payload?.refresh_token ?? "").trim();
  const tokenType = String(payload?.token_type ?? "Bearer").trim();
  const expiresIn = Number(payload?.expires_in ?? 0);
  const expiresAtRaw = payload?.expires_at;
  const expiresAt = expiresAtRaw
    ? new Date(toEpochMs(expiresAtRaw)).toISOString()
    : Number.isFinite(expiresIn) && expiresIn > 0
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : "";

  if (!accessToken) {
    throw new Error("mcp auth finish failed: missing access_token");
  }

  data.mcp.auth[id] = {
    ...previous,
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: tokenType,
    expires_at: expiresAt,
    pending_state: "",
    updated_at: nowIso()
  };

  await saveProfiles(data, resolvedPath);

  print(output, `mcp auth finish ok id=${id}`);
  print(output, `has_access_token=${Boolean(accessToken)}`);
  print(output, `expires_at=${expiresAt}`);
  print(output, `profile_path=${resolvedPath}`);
}

async function runMcpAuthCommand(args, options) {
  const [subcommand = "status", ...rest] = args;
  const normalized = String(subcommand).toLowerCase();

  if (normalized === "status") {
    await handleMcpAuthStatus(rest, options);
    return;
  }
  if (normalized === "start") {
    await handleMcpAuthStart(rest, options);
    return;
  }
  if (normalized === "finish") {
    await handleMcpAuthFinish(rest, options);
    return;
  }
  if (normalized === "clear") {
    await handleMcpAuthClear(rest, options);
    return;
  }

  throw new Error(`Unknown mcp auth subcommand '${subcommand}'. Use: status | start | finish | clear`);
}

export async function runMcpCommand(args, options) {
  const [subcommand = "list", ...rest] = args;
  const normalized = String(subcommand).toLowerCase();

  if (normalized === "list") {
    await handleMcpList(options);
    return;
  }
  if (normalized === "add") {
    await handleMcpAdd(rest, options);
    return;
  }
  if (normalized === "remove") {
    await handleMcpRemove(rest, options);
    return;
  }
  if (normalized === "enable") {
    await handleMcpToggle(rest, options, true);
    return;
  }
  if (normalized === "disable") {
    await handleMcpToggle(rest, options, false);
    return;
  }
  if (normalized === "auth") {
    await runMcpAuthCommand(rest, options);
    return;
  }

  throw new Error(`Unknown mcp subcommand '${subcommand}'. Use: list | add | remove | enable | disable | auth`);
}

export async function runProviderUtilityCommand({
  argv,
  output = process.stdout,
  errorOutput = process.stderr,
  env = process.env,
  storePath = "",
  fetchImpl = fetch
}) {
  const [command = "", ...rest] = argv;
  const options = {
    output,
    errorOutput,
    env,
    storePath,
    fetchImpl
  };

  if (command === "auth") {
    await runAuthCommand(rest, options);
    return true;
  }

  if (command === "models") {
    await runModelsCommand(rest, options);
    return true;
  }

  if (command === "mcp") {
    await runMcpCommand(rest, options);
    return true;
  }

  return false;
}
