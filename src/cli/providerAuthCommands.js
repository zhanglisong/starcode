import { DEFAULT_ENDPOINTS, normalizeProviderName, resolveEndpoint } from "../providers/openAICompatibleProvider.js";
import { listProviderModels } from "../providers/modelCatalog.js";
import { loadProfiles, maskSecret, saveProfiles } from "./profileStore.js";

function parseArgs(args) {
  const positionals = [];
  const flags = {};

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = args[i + 1];
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
  const servers = Object.entries(data?.mcp?.servers ?? {})
    .map(([id, server]) => ({
      id,
      enabled: server?.enabled !== false,
      type: String(server?.type ?? "http"),
      endpoint: String(server?.endpoint ?? ""),
      version: String(server?.version ?? "v1"),
      api_key: String(server?.api_key ?? ""),
      api_key_env: String(server?.api_key_env ?? ""),
      headers: server?.headers && typeof server.headers === "object" ? server.headers : {}
    }))
    .filter((server) => server.enabled);

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
    print(output, `auth logout ok provider=all`);
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
    print(
      output,
      `- ${id} enabled=${server?.enabled !== false} type=${server?.type ?? "http"} endpoint=${server?.endpoint ?? ""} version=${server?.version ?? "v1"}`
    );
  }
}

async function handleMcpAdd(args, { output, storePath }) {
  const { positionals, flags } = parseArgs(args);
  const id = String(positionals[0] ?? "").trim();
  if (!id) {
    throw new Error("Missing MCP server id. Usage: starcode mcp add <id> --endpoint <url>");
  }

  const endpoint = String(flags.endpoint ?? "").trim();
  if (!endpoint) {
    throw new Error("Missing --endpoint for MCP server.");
  }

  const { path: resolvedPath, data } = await loadProfiles(storePath);
  const previous = data?.mcp?.servers?.[id] ?? {};
  const headers = {
    ...(previous.headers && typeof previous.headers === "object" ? previous.headers : {}),
    ...parseHeaderPairs(String(flags.header ?? ""))
  };

  data.mcp = data.mcp && typeof data.mcp === "object" ? data.mcp : { servers: {} };
  data.mcp.servers = data.mcp.servers && typeof data.mcp.servers === "object" ? data.mcp.servers : {};
  data.mcp.servers[id] = {
    id,
    type: String(flags.type ?? previous.type ?? "http"),
    endpoint,
    enabled: flags.disabled ? false : true,
    version: String(flags.version ?? previous.version ?? "v1"),
    api_key: String(flags["api-key"] ?? previous.api_key ?? ""),
    api_key_env: String(flags["api-key-env"] ?? previous.api_key_env ?? ""),
    headers
  };

  await saveProfiles(data, resolvedPath);

  print(output, `mcp add ok id=${id}`);
  print(output, `endpoint=${endpoint}`);
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

  throw new Error(`Unknown mcp subcommand '${subcommand}'. Use: list | add | remove | enable | disable`);
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
