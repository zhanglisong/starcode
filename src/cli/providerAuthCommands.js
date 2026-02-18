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

  return false;
}
