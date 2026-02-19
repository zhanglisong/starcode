#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { TelemetryClient } from "../telemetry/telemetryClient.js";
import { OpenAICompatibleProvider, MockProvider } from "../providers/openAICompatibleProvider.js";
import { StarcodeAgent } from "../agent/starcodeAgent.js";
import { LocalFileTools } from "../tools/localFileTools.js";
import { ModelIoLogger } from "../telemetry/modelIoLogger.js";
import { GitContextProvider } from "../context/gitContextProvider.js";
import { parseSlashCommand, renderSlashHelpText } from "./commandFlows.js";
import { resolveRuntimeMcpConfig, resolveRuntimeModelConfig, runProviderUtilityCommand } from "./providerAuthCommands.js";
import { McpManager } from "../mcp/mcpManager.js";
import { loadHistory, saveHistory } from "./historyStore.js";

function env(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === null || v === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function parseCsv(input) {
  if (!input || typeof input !== "string") {
    return [];
  }
  return input
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseRegexCsv(input) {
  return parseCsv(input).map((pattern) => {
    try {
      return new RegExp(pattern, "i");
    } catch {
      return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
  });
}

function resolvePromptVersion() {
  return String(process.env.STARCODE_PROMPT_VERSION ?? "v1").toLowerCase();
}

function resolveSystemPrompt(promptVersion) {
  const defaults = {
    v1: "You are Starcode, an enterprise coding agent. Use available tools for real file operations when asked to read, list, or write files.",
    v2:
      "You are Starcode, an enterprise coding agent. Prefer precise, minimal edits, verify changes with tools when possible, and report concrete evidence of completion."
  };

  const versionKey = `SYSTEM_PROMPT_${String(promptVersion).toUpperCase()}`;
  if (process.env.SYSTEM_PROMPT) {
    return process.env.SYSTEM_PROMPT;
  }
  if (process.env[versionKey]) {
    return process.env[versionKey];
  }
  return defaults[promptVersion] ?? defaults.v1;
}

function createProvider({ providerName, apiKey, endpoint }) {
  const mode = String(providerName ?? process.env.MODEL_PROVIDER ?? "mock").toLowerCase();

  if (mode === "mock") {
    return new MockProvider();
  }

  const resolvedApiKey = mode === "ollama" ? apiKey ?? process.env.MODEL_API_KEY ?? "ollama" : apiKey || env("MODEL_API_KEY");

  return new OpenAICompatibleProvider({
    apiKey: resolvedApiKey,
    endpoint: endpoint ?? process.env.MODEL_ENDPOINT,
    providerName: mode
  });
}

async function nextLine(rl) {
  try {
    return await rl.question("you> ");
  } catch (error) {
    if (error?.code === "ERR_USE_AFTER_CLOSE") {
      return null;
    }
    throw error;
  }
}

function renderPlan(plan) {
  if (!plan || !Array.isArray(plan.steps)) {
    return "";
  }
  const lines = [
    "plan>",
    `goal: ${plan.goal}`
  ];
  for (let i = 0; i < plan.steps.length; i += 1) {
    lines.push(`${i + 1}. ${plan.steps[i].text}`);
  }
  return lines.join("\n");
}

function formatTokens(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return "0";
  }
  return Math.round(parsed).toLocaleString("en-US");
}

function formatMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return "0ms";
  }
  if (parsed < 1000) {
    return `${Math.round(parsed)}ms`;
  }
  return `${(parsed / 1000).toFixed(2)}s`;
}

function renderStartupPanel({
  providerName,
  model,
  workspaceDir,
  enableStreaming,
  enablePlanningMode,
  enableSessionSummary,
  enableCliHistory,
  mcpServerCount,
  promptVersion,
  toolSchemaVersion,
  modelIoDebugEnabled,
  modelIoFilePath
}) {
  const modelLabel = model && String(model).trim() ? String(model).trim() : "(unset)";
  const providerLabel = providerName && String(providerName).trim() ? String(providerName).trim() : "(unset)";
  const lines = [
    "┌─────────────────────────────── Starcode ───────────────────────────────┐",
    `│ model=${modelLabel} provider=${providerLabel} streaming=${enableStreaming ? "on" : "off"} planning=${enablePlanningMode ? "on" : "off"} │`,
    `│ workspace=${workspaceDir} │`,
    `│ mcp_servers=${mcpServerCount} session_summary=${enableSessionSummary ? "on" : "off"} history=${enableCliHistory ? "on" : "off"} │`,
    `│ prompt=${promptVersion} tools=${toolSchemaVersion} │`
  ];

  if (modelIoDebugEnabled) {
    lines.push(`│ model_io_debug=on file=${modelIoFilePath} │`);
  }

  lines.push("└──────────────────────────────────────────────────────────────────────────┘");
  lines.push("Use /help for workflow commands (/fix, /test, /explain, /commit). Type 'exit' to quit.");
  return `${lines.join("\n")}\n`;
}

function renderTurnStats({
  model,
  usage,
  latencyMs,
  latencyBreakdown,
  traceId,
  flushed,
  cumulativeTokens
}) {
  const modelLabel = model && String(model).trim() ? String(model).trim() : "(unset)";
  const promptTokens = Number(usage?.prompt_tokens ?? 0);
  const completionTokens = Number(usage?.completion_tokens ?? 0);
  const totalTokens = Number(usage?.total_tokens ?? promptTokens + completionTokens);
  const breakdown = latencyBreakdown ?? {};

  return [
    "stats>",
    `model=${modelLabel} tokens(prompt/completion/total)=${formatTokens(promptTokens)}/${formatTokens(completionTokens)}/${formatTokens(totalTokens)} cumulative_total=${formatTokens(cumulativeTokens)}`,
    `latency(total/model/tool/other)=${formatMs(latencyMs)}/${formatMs(breakdown.model_ms)}/${formatMs(breakdown.tool_ms)}/${formatMs(breakdown.other_ms)} trace_id=${traceId} flushed=${flushed}`
  ].join("\n");
}

async function main() {
  const cliArgs = process.argv.slice(2);
  if (cliArgs.length > 0) {
    const handled = await runProviderUtilityCommand({
      argv: cliArgs,
      output,
      errorOutput: process.stderr,
      env: process.env
    });
    if (handled) {
      return;
    }
    if (cliArgs[0] === "help" || cliArgs[0] === "--help" || cliArgs[0] === "-h") {
      output.write("Starcode usage:\n");
      output.write("  starcode                      # interactive agent mode\n");
      output.write("  starcode auth login <provider> [--api-key <key>] [--endpoint <url>] [--model <id>]\n");
      output.write("  starcode auth logout [provider|--all]\n");
      output.write("  starcode auth list\n");
      output.write("  starcode models list [provider] [--endpoint <url>] [--api-key <key>]\n");
      output.write("  starcode models use <model_id> [--provider <provider>]\n");
      output.write("  starcode mcp list\n");
      output.write("  starcode mcp add <id> --endpoint <url> [--type http] [--api-key <key>] [--api-key-env <ENV>] [--header Key:Value]\n");
      output.write("  starcode mcp remove <id>\n");
      output.write("  starcode mcp enable <id>\n");
      output.write("  starcode mcp disable <id>\n");
      return;
    }
    throw new Error(`Unknown command '${cliArgs[0]}'. Run 'starcode help' for available commands.`);
  }

  const runtimeModelConfig = await resolveRuntimeModelConfig({ env: process.env });
  const runtimeMcpConfig = await resolveRuntimeMcpConfig({ env: process.env });
  const sessionId = process.env.SESSION_ID ?? randomUUID();

  const telemetry = new TelemetryClient({
    endpoint: process.env.TELEMETRY_ENDPOINT,
    apiKey: process.env.TELEMETRY_API_KEY,
    orgId: env("ORG_ID", "acme"),
    engineerId: env("ENGINEER_ID", os.userInfo().username),
    teamId: process.env.TEAM_ID ?? "platform",
    projectId: process.env.PROJECT_ID ?? "starcode",
    sessionId,
    spoolDir: process.env.TELEMETRY_SPOOL_DIR ?? ".telemetry",
    redact: process.env.TELEMETRY_REDACT !== "false",
    retryBaseMs: Number(process.env.TELEMETRY_RETRY_BASE_MS ?? 1000),
    retryMaxMs: Number(process.env.TELEMETRY_RETRY_MAX_MS ?? 30000),
    retryMultiplier: Number(process.env.TELEMETRY_RETRY_MULTIPLIER ?? 2)
  });

  const provider = createProvider({
    providerName: runtimeModelConfig.provider,
    apiKey: runtimeModelConfig.apiKey,
    endpoint: runtimeModelConfig.endpoint
  });
  const model = runtimeModelConfig.model;
  const workspaceDir = process.env.STARCODE_WORKSPACE_DIR ?? process.cwd();
  const enableStreaming = process.env.STARCODE_ENABLE_STREAMING !== "false";
  const enablePlanningMode = process.env.STARCODE_ENABLE_PLANNING_MODE === "true";
  const enableSessionSummary = process.env.STARCODE_ENABLE_SESSION_SUMMARY !== "false";
  const promptVersion = resolvePromptVersion();
  const toolSchemaVersion = String(process.env.STARCODE_TOOL_SCHEMA_VERSION ?? "v1").toLowerCase();
  const sessionSummaryTriggerMessages = Number(process.env.STARCODE_SESSION_SUMMARY_TRIGGER_MESSAGES ?? 18);
  const sessionSummaryKeepRecent = Number(process.env.STARCODE_SESSION_SUMMARY_KEEP_RECENT ?? 8);
  const systemPrompt = resolveSystemPrompt(promptVersion);
  const localTools = new LocalFileTools({
    baseDir: workspaceDir,
    enableShellTool: process.env.STARCODE_ENABLE_SHELL_TOOL !== "false",
    shellTimeoutMs: Number(process.env.STARCODE_SHELL_TIMEOUT_MS ?? 15_000),
    maxShellTimeoutMs: Number(process.env.STARCODE_SHELL_MAX_TIMEOUT_MS ?? 120_000),
    shellMaxOutputBytes: Number(process.env.STARCODE_SHELL_MAX_OUTPUT_BYTES ?? 32_000),
    shellAllowCommands: parseCsv(process.env.STARCODE_SHELL_ALLOW_COMMANDS),
    shellDenyPatterns: parseRegexCsv(process.env.STARCODE_SHELL_DENY_PATTERNS),
    enableWebSearchTool: process.env.STARCODE_ENABLE_WEB_SEARCH_TOOL === "true",
    webSearchProvider: process.env.STARCODE_WEB_SEARCH_PROVIDER ?? "duckduckgo",
    webSearchEndpoint: process.env.STARCODE_WEB_SEARCH_ENDPOINT ?? "",
    webSearchApiKey: process.env.STARCODE_WEB_SEARCH_API_KEY ?? "",
    webSearchTimeoutMs: Number(process.env.STARCODE_WEB_SEARCH_TIMEOUT_MS ?? 8000),
    webSearchMaxResults: Number(process.env.STARCODE_WEB_SEARCH_MAX_RESULTS ?? 8)
  });
  const gitContextProvider = new GitContextProvider({
    baseDir: workspaceDir,
    enabled: process.env.STARCODE_ENABLE_GIT_CONTEXT !== "false",
    timeoutMs: Number(process.env.STARCODE_GIT_CONTEXT_TIMEOUT_MS ?? 1500),
    maxChars: Number(process.env.STARCODE_GIT_CONTEXT_MAX_CHARS ?? 3000),
    maxChangedFiles: Number(process.env.STARCODE_GIT_CONTEXT_MAX_CHANGED_FILES ?? 30),
    maxStatusLines: Number(process.env.STARCODE_GIT_CONTEXT_MAX_STATUS_LINES ?? 30)
  });
  const modelIoDebugEnabled = process.env.STARCODE_DEBUG_MODEL_IO === "1";
  const modelIoFilePathInput = process.env.STARCODE_DEBUG_MODEL_IO_FILE ?? ".telemetry/model-io.jsonl";
  const modelIoFilePath = path.isAbsolute(modelIoFilePathInput)
    ? modelIoFilePathInput
    : path.resolve(workspaceDir, modelIoFilePathInput);
  const enableCliHistory = process.env.STARCODE_ENABLE_CLI_HISTORY !== "false";
  const cliHistoryFilePathInput = process.env.STARCODE_CLI_HISTORY_FILE ?? ".telemetry/cli-history.txt";
  const cliHistoryFilePath = path.isAbsolute(cliHistoryFilePathInput)
    ? cliHistoryFilePathInput
    : path.resolve(workspaceDir, cliHistoryFilePathInput);
  const cliHistoryMaxEntries = Number(process.env.STARCODE_CLI_HISTORY_MAX_ENTRIES ?? 500);
  let cliHistoryEntries = enableCliHistory ? await loadHistory(cliHistoryFilePath, cliHistoryMaxEntries) : [];
  const modelIoLogger = new ModelIoLogger({
    enabled: modelIoDebugEnabled,
    filePath: modelIoFilePath
  });
  const mcpManager = new McpManager({
    servers: runtimeMcpConfig.servers,
    env: process.env,
    timeoutMs: Number(process.env.STARCODE_MCP_TIMEOUT_MS ?? 8000),
    cacheTtlMs: Number(process.env.STARCODE_MCP_CACHE_TTL_MS ?? 5000)
  });

  const agent = new StarcodeAgent({
    provider,
    telemetry,
    modelIoLogger,
    gitContextProvider,
    mcpManager,
    localTools,
    model,
    systemPrompt,
    promptVersion,
    toolSchemaVersion,
    temperature: Number(process.env.MODEL_TEMPERATURE ?? 0.2),
    topP: Number(process.env.MODEL_TOP_P ?? 1),
    maxTokens: Number(process.env.MODEL_MAX_TOKENS ?? 1024),
    enableStreaming,
    enablePlanningMode,
    enableSessionSummary,
    sessionSummaryTriggerMessages,
    sessionSummaryKeepRecent
  });

  await telemetry.captureSessionMeta({
    traceId: randomUUID(),
    mode: "interactive-cli",
    git: {
      branch: process.env.GIT_BRANCH ?? "unknown"
    },
    machine: {
      hostname: os.hostname(),
      platform: process.platform,
      release: os.release()
    }
  });
  await telemetry.flush();

  const rl = readline.createInterface({
    input,
    output,
    terminal: Boolean(input.isTTY && output.isTTY),
    historySize: cliHistoryMaxEntries,
    removeHistoryDuplicates: false
  });
  if (enableCliHistory && Array.isArray(rl.history) && cliHistoryEntries.length > 0) {
    rl.history = [...cliHistoryEntries].reverse();
  }
  output.write(
    renderStartupPanel({
      providerName: provider.providerName,
      model,
      workspaceDir,
      enableStreaming,
      enablePlanningMode,
      enableSessionSummary,
      enableCliHistory,
      mcpServerCount: runtimeMcpConfig.servers.length,
      promptVersion,
      toolSchemaVersion,
      modelIoDebugEnabled,
      modelIoFilePath
    })
  );

  let cumulativeTokens = 0;

  while (true) {
    const rawLine = await nextLine(rl);
    if (rawLine === null) {
      break;
    }

    const line = rawLine.trim();

    if (!line) {
      continue;
    }

    if (line === "exit") {
      break;
    }

    if (enableCliHistory) {
      cliHistoryEntries.push(line);
      if (cliHistoryEntries.length > cliHistoryMaxEntries) {
        cliHistoryEntries = cliHistoryEntries.slice(cliHistoryEntries.length - cliHistoryMaxEntries);
      }
    }

    const slashCommand = parseSlashCommand(line);
    if (slashCommand?.kind === "help") {
      output.write(`${renderSlashHelpText()}\n`);
      continue;
    }
    if (slashCommand?.kind === "unknown") {
      output.write(`error> unknown slash command '/${slashCommand.command || ""}'. Type /help.\n`);
      continue;
    }

    const turnInput = slashCommand?.kind === "command" ? slashCommand.prompt : line;

    try {
      if (slashCommand?.kind === "command") {
        output.write(`workflow> /${slashCommand.command}${slashCommand.args ? ` ${slashCommand.args}` : ""}\n`);
      }
      let streamed = false;
      const turn = await agent.runTurn(turnInput, {
        stream: enableStreaming,
        planning: enablePlanningMode,
        onPlan: (plan) => {
          output.write(`${renderPlan(plan)}\n`);
        },
        onTextDelta: (chunk) => {
          if (!streamed) {
            output.write("assistant> ");
            streamed = true;
          }
          output.write(chunk);
        }
      });
      if (streamed) {
        output.write("\n");
      } else {
        output.write(`assistant> ${turn.outputText}\n`);
      }
      const promptTokens = Number(turn.usage?.prompt_tokens ?? 0);
      const completionTokens = Number(turn.usage?.completion_tokens ?? 0);
      const totalTokens = Number(turn.usage?.total_tokens ?? promptTokens + completionTokens);
      cumulativeTokens += Number.isFinite(totalTokens) ? Math.max(0, totalTokens) : 0;
      output.write(
        `${renderTurnStats({
          model,
          usage: turn.usage,
          latencyMs: turn.latencyMs,
          latencyBreakdown: turn.latencyBreakdown,
          traceId: turn.traceId,
          flushed: turn.flush.flushed,
          cumulativeTokens
        })}\n`
      );
    } catch (error) {
      output.write(`error> ${error.message}\n`);
    }
  }

  if (enableCliHistory) {
    try {
      await saveHistory(cliHistoryFilePath, cliHistoryEntries, cliHistoryMaxEntries);
    } catch (error) {
      output.write(`warn> failed to persist history: ${error.message}\n`);
    }
  }

  await telemetry.flush(1000);
  rl.close();
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
