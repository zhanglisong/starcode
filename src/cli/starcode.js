#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import readline from "node:readline/promises";
import { clearLine, cursorTo, moveCursor } from "node:readline";
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
import { PermissionManager } from "../permission/permissionManager.js";
import { RuntimeApprovalStore } from "../permission/runtimeApprovalStore.js";
import { SessionStore } from "../session/store.js";
import { runSessionCommand } from "./sessionCommands.js";
import { shouldRenderFinalOutputAfterStreaming } from "./outputRendering.js";

const UI_MODES = {
  PLAIN: "plain",
  TUI: "tui"
};

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  reverse: "\u001b[7m"
};

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

function resolveUiMode(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === UI_MODES.TUI) {
    return UI_MODES.TUI;
  }
  return UI_MODES.PLAIN;
}

function parseInteractiveCliFlags(args) {
  const remainingArgs = [];
  let uiMode = resolveUiMode(process.env.STARCODE_UI ?? UI_MODES.PLAIN);
  let sessionId = String(process.env.STARCODE_SESSION_ID ?? "").trim();
  let forkSessionId = "";

  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i] ?? "");

    if (token === "--ui" || token === "--session" || token === "--fork-session") {
      const next = String(args[i + 1] ?? "");
      if (!next || next.startsWith("--")) {
        throw new Error(`Missing value for ${token}.`);
      }
      if (token === "--ui") {
        uiMode = resolveUiMode(next);
      } else if (token === "--session") {
        sessionId = next;
      } else {
        forkSessionId = next;
      }
      i += 1;
      continue;
    }

    if (token.startsWith("--ui=")) {
      uiMode = resolveUiMode(token.slice("--ui=".length));
      continue;
    }

    if (token.startsWith("--session=")) {
      sessionId = token.slice("--session=".length);
      continue;
    }

    if (token.startsWith("--fork-session=")) {
      forkSessionId = token.slice("--fork-session=".length);
      continue;
    }

    remainingArgs.push(token);
  }

  return {
    uiMode,
    sessionId: String(sessionId || "").trim(),
    forkSessionId: String(forkSessionId || "").trim(),
    remainingArgs
  };
}

function applyStyle(value, code, enabled) {
  if (!enabled) {
    return value;
  }
  return `${code}${value}${ANSI.reset}`;
}

function formatBuildDuration(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return "0ms";
  }
  if (parsed < 1000) {
    return `${Math.round(parsed)}ms`;
  }
  return `${(parsed / 1000).toFixed(1)}s`;
}

function prefixLines(value, prefix = "| ") {
  const text = String(value ?? "");
  const lines = text.length ? text.split("\n") : [""];
  return lines.map((line) => `${prefix}${line}`).join("\n");
}

function renderTuiStartup({ model, workspaceDir, ansiEnabled }) {
  const line1 = `${applyStyle("Starcode TUI", ANSI.bold, ansiEnabled)} · ${applyStyle(
    model || "(unset)",
    ANSI.dim,
    ansiEnabled
  )}`;
  const line2 = `${applyStyle("workspace", ANSI.dim, ansiEnabled)} ${workspaceDir}`;
  return `${line1}\n${line2}\n\n`;
}

function renderTuiTurnFooter({ model, latencyMs, ansiEnabled }) {
  const duration = formatBuildDuration(latencyMs);
  const footer = `${applyStyle("#", ANSI.bold, ansiEnabled)} ${applyStyle("Starcode", ANSI.bold, ansiEnabled)} · ${applyStyle(
    model || "(unset)",
    ANSI.dim,
    ansiEnabled
  )} · ${applyStyle(duration, ANSI.dim, ansiEnabled)}`;
  return `\n${footer}\n`;
}

function renderTuiPromptLabel() {
  return "> ";
}

function clearSubmittedPromptEchoLine({ uiMode, isTty }) {
  if (uiMode !== UI_MODES.TUI || !isTty) {
    return;
  }

  try {
    moveCursor(output, 0, -1);
    clearLine(output, 0);
    cursorTo(output, 0);
  } catch {
    // Best-effort cleanup only.
  }
}

function renderTuiHistoricalInputRow({ inputText, ansiEnabled }) {
  const compactInput = String(inputText ?? "").replace(/\r?\n/g, " ").trim();
  const row = applyStyle(`> ${compactInput}`, ANSI.reverse, ansiEnabled);
  return `\r \r${row}\n\n`;
}

async function nextLine(rl, promptLabel = "you> ") {
  try {
    return await rl.question(promptLabel);
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
  const lines = ["plan>", `goal: ${plan.goal}`];
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

function clampNumber(value, fallback = 0, min = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, parsed);
}

function formatPercent(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return "0%";
  }
  if (parsed >= 100) {
    return "100%";
  }
  return `${parsed.toFixed(parsed < 10 ? 2 : 1)}%`;
}

function formatUsd(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return "$0.00";
  }
  if (parsed < 0.01) {
    return `$${parsed.toFixed(4)}`;
  }
  return `$${parsed.toFixed(2)}`;
}

function resolveUsage(usage) {
  const promptTokens = clampNumber(usage?.prompt_tokens, 0, 0);
  const completionTokens = clampNumber(usage?.completion_tokens, 0, 0);
  const totalTokens = clampNumber(usage?.total_tokens, promptTokens + completionTokens, 0);
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    estimated: usage?.estimated === true
  };
}

function computeSpendUsd({
  promptTokens,
  completionTokens,
  inputCostPer1k,
  outputCostPer1k
}) {
  const promptCost = (clampNumber(promptTokens, 0, 0) / 1000) * clampNumber(inputCostPer1k, 0, 0);
  const completionCost = (clampNumber(completionTokens, 0, 0) / 1000) * clampNumber(outputCostPer1k, 0, 0);
  return promptCost + completionCost;
}

function renderStartupPanel({
  providerName,
  model,
  workspaceDir,
  sessionId,
  enableStreaming,
  enablePlanningMode,
  enableSessionSummary,
  enableCliHistory,
  mcpServerCount,
  contextWindowTokens,
  inputCostPer1k,
  outputCostPer1k,
  promptVersion,
  toolSchemaVersion,
  modelIoDebugEnabled,
  modelIoFilePath,
  uiMode
}) {
  const modelLabel = model && String(model).trim() ? String(model).trim() : "(unset)";
  const providerLabel = providerName && String(providerName).trim() ? String(providerName).trim() : "(unset)";
  const lines = [
    "+------------------------------- Starcode -------------------------------+",
    `| Starcode · ${modelLabel} · provider=${providerLabel} · streaming=${enableStreaming ? "on" : "off"} · planning=${enablePlanningMode ? "on" : "off"} |`,
    `| workspace=${workspaceDir} |`,
    `| session=${sessionId} |`,
    `| context window=${formatTokens(contextWindowTokens)} tokens · pricing(in/out per 1k)=${inputCostPer1k}/${outputCostPer1k} |`,
    `| mcp_servers=${mcpServerCount} · session_summary=${enableSessionSummary ? "on" : "off"} · history=${enableCliHistory ? "on" : "off"} |`,
    `| prompt=${promptVersion} · tools=${toolSchemaVersion} · ui=${uiMode} |`
  ];

  if (modelIoDebugEnabled) {
    lines.push(`| model_io_debug=on file=${modelIoFilePath} |`);
  }

  lines.push("+-----------------------------------------------------------------------+");
  lines.push("Use /help for workflow commands (/fix, /test, /explain, /commit). Type 'exit' to quit.");
  return `${lines.join("\n")}\n`;
}

function renderTurnStats({
  model,
  providerName,
  usage,
  latencyMs,
  latencyBreakdown,
  traceId,
  flushed,
  cumulativePromptTokens,
  cumulativeCompletionTokens,
  cumulativeTokens,
  contextWindowTokens,
  cumulativeSpendUsd
}) {
  const modelLabel = model && String(model).trim() ? String(model).trim() : "(unset)";
  const providerLabel = providerName && String(providerName).trim() ? String(providerName).trim() : "(unset)";
  const resolvedUsage = resolveUsage(usage);
  const breakdown = latencyBreakdown ?? {};
  const usedPct = contextWindowTokens > 0 ? (cumulativeTokens / contextWindowTokens) * 100 : 0;
  const sourceLabel = resolvedUsage.estimated ? "estimated" : "provider";

  return [
    "stats>",
    `Starcode · ${modelLabel} · ${providerLabel} · ${formatMs(latencyMs)}`,
    `context · ${formatTokens(cumulativeTokens)}/${formatTokens(contextWindowTokens)} tokens · ${formatPercent(usedPct)} used · ${formatUsd(cumulativeSpendUsd)} spent`,
    `tokens · turn=${formatTokens(resolvedUsage.promptTokens)}/${formatTokens(resolvedUsage.completionTokens)}/${formatTokens(resolvedUsage.totalTokens)} · session=${formatTokens(cumulativePromptTokens)}/${formatTokens(cumulativeCompletionTokens)}/${formatTokens(cumulativeTokens)} · source=${sourceLabel}`,
    `latency · total/model/tool/other=${formatMs(latencyMs)}/${formatMs(breakdown.model_ms)}/${formatMs(breakdown.tool_ms)}/${formatMs(breakdown.other_ms)}`,
    `trace · id=${traceId} · flushed=${flushed}`
  ].join("\n");
}

function renderStatusWithoutTurns({ model, providerName, contextWindowTokens, cumulativeSpendUsd }) {
  const modelLabel = model && String(model).trim() ? String(model).trim() : "(unset)";
  const providerLabel = providerName && String(providerName).trim() ? String(providerName).trim() : "(unset)";
  return [
    "stats>",
    `Starcode · ${modelLabel} · ${providerLabel} · n/a`,
    `context · 0/${formatTokens(contextWindowTokens)} tokens · 0% used · ${formatUsd(cumulativeSpendUsd)} spent`,
    "tokens · turn=0/0/0 · session=0/0/0 · source=n/a",
    "latency · total/model/tool/other=0ms/0ms/0ms/0ms",
    "trace · id=n/a · flushed=0"
  ].join("\n");
}

function resolveSessionDir(workspaceDir) {
  const raw = String(process.env.STARCODE_SESSION_DIR ?? ".telemetry/sessions");
  return path.isAbsolute(raw) ? raw : path.resolve(workspaceDir, raw);
}

function resolvePermissionStorePath() {
  const raw = String(process.env.STARCODE_PERMISSION_STORE_PATH ?? "").trim();
  if (!raw) {
    return "";
  }
  return path.resolve(raw);
}

async function promptPermissionDecision({ rl, uiMode, request, matched }) {
  if (!rl) {
    return {
      reply: "reject",
      message: "non-interactive session"
    };
  }

  const header = [
    "permission>",
    `tool_permission=${request?.permission ?? "unknown"}`,
    `targets=${(request?.patterns ?? []).join(", ") || "*"}`,
    `tool=${request?.metadata?.tool_name ?? "unknown"}`
  ].join(" ");

  output.write(uiMode === UI_MODES.TUI ? `${prefixLines(header)}\n` : `${header}\n`);

  const denyRule = Array.isArray(matched) ? matched.find((item) => item?.action === "deny") : null;
  if (denyRule?.rule) {
    output.write(`permission> matched deny rule ${denyRule.rule.permission}:${denyRule.rule.pattern} (${denyRule.rule.source})\n`);
  }

  const answer = String(
    (await rl.question("permission> allow once/always/reject? [once]: ")) ?? ""
  )
    .trim()
    .toLowerCase();

  if (!answer || answer === "once" || answer === "o" || answer === "1") {
    return { reply: "once" };
  }

  if (answer === "always" || answer === "a" || answer === "2") {
    return { reply: "always" };
  }

  let message = "";
  if (answer.startsWith("reject ")) {
    message = answer.slice("reject ".length).trim();
  } else {
    message = String((await rl.question("permission> optional rejection note: ")) ?? "").trim();
  }

  return {
    reply: "reject",
    message
  };
}

async function promptQuestionAnswers({ rl, uiMode, questions }) {
  if (!rl) {
    return {
      answers: Array.isArray(questions)
        ? questions.map((item) => ({
            id: item?.id ?? "question",
            answers: []
          }))
        : []
    };
  }

  const normalized = Array.isArray(questions) ? questions : [];
  const answers = [];
  for (const question of normalized) {
    const id = String(question?.id ?? "question").trim() || "question";
    const promptLine = String(question?.question ?? "").trim() || "Provide answer";
    const header = String(question?.header ?? "").trim();
    const options = Array.isArray(question?.options) ? question.options : [];

    if (header) {
      const line = `question> ${header}`;
      output.write(uiMode === UI_MODES.TUI ? `${prefixLines(line)}\n` : `${line}\n`);
    }
    output.write(uiMode === UI_MODES.TUI ? `${prefixLines(`question> ${promptLine}`)}\n` : `question> ${promptLine}\n`);

    if (options.length > 0) {
      options.forEach((option, index) => {
        const label = String(option?.label ?? "").trim();
        const description = String(option?.description ?? "").trim();
        if (!label) {
          return;
        }
        output.write(
          uiMode === UI_MODES.TUI
            ? `${prefixLines(`question> ${index + 1}. ${label}${description ? ` - ${description}` : ""}`)}\n`
            : `question> ${index + 1}. ${label}${description ? ` - ${description}` : ""}\n`
        );
      });
    }

    const raw = String((await rl.question("question> answer (number, comma list, or text): ")) ?? "").trim();
    if (!raw) {
      answers.push({ id, answers: [] });
      continue;
    }

    const tokens = raw.split(",").map((item) => item.trim()).filter(Boolean);
    const mapped = [];
    for (const token of tokens) {
      const index = Number(token);
      if (Number.isFinite(index) && index >= 1 && index <= options.length) {
        const value = String(options[index - 1]?.label ?? "").trim();
        if (value) {
          mapped.push(value);
        }
      } else {
        mapped.push(token);
      }
    }
    answers.push({
      id,
      answers: mapped.length ? mapped : [raw]
    });
  }

  return { answers };
}

async function main() {
  const parsedCli = parseInteractiveCliFlags(process.argv.slice(2));
  const uiMode = parsedCli.uiMode;
  const ansiEnabled = Boolean(output.isTTY && process.env.NO_COLOR !== "1" && uiMode === UI_MODES.TUI);
  const workspaceDir = process.env.STARCODE_WORKSPACE_DIR ?? process.cwd();

  if (parsedCli.remainingArgs.length > 0) {
    const command = String(parsedCli.remainingArgs[0] ?? "").toLowerCase();
    if (command === "session") {
      await runSessionCommand(parsedCli.remainingArgs.slice(1), {
        output,
        workspaceDir,
        sessionDir: process.env.STARCODE_SESSION_DIR
      });
      return;
    }

    const handled = await runProviderUtilityCommand({
      argv: parsedCli.remainingArgs,
      output,
      errorOutput: process.stderr,
      env: process.env
    });
    if (handled) {
      return;
    }
    if (command === "help" || command === "--help" || command === "-h") {
      output.write("Starcode usage:\n");
      output.write("  starcode [--ui plain|tui] [--session <id>] [--fork-session <id>]\n");
      output.write("  starcode auth login <provider> [--api-key <key>] [--endpoint <url>] [--model <id>]\n");
      output.write("  starcode auth logout [provider|--all]\n");
      output.write("  starcode auth list\n");
      output.write("  starcode models list [provider] [--endpoint <url>] [--api-key <key>]\n");
      output.write("  starcode models use <model_id> [--provider <provider>]\n");
      output.write("  starcode mcp list\n");
      output.write("  starcode mcp add <id> --endpoint <url> [--type http|sse|stdio|remote] ...\n");
      output.write("  starcode mcp remove <id>\n");
      output.write("  starcode mcp enable <id>\n");
      output.write("  starcode mcp disable <id>\n");
      output.write("  starcode mcp auth status <id>\n");
      output.write("  starcode mcp auth start <id>\n");
      output.write("  starcode mcp auth finish <id> --code <code>\n");
      output.write("  starcode mcp auth clear <id>\n");
      output.write("  starcode session list\n");
      output.write("  starcode session delete <id>\n");
      output.write("  starcode session fork <id> [--session <new_id>]\n");
      return;
    }
    throw new Error(`Unknown command '${parsedCli.remainingArgs[0]}'. Run 'starcode help' for available commands.`);
  }

  const runtimeModelConfig = await resolveRuntimeModelConfig({ env: process.env });
  const runtimeMcpConfig = await resolveRuntimeMcpConfig({ env: process.env });

  const sessionStore = new SessionStore({
    baseDir: resolveSessionDir(workspaceDir)
  });
  const selectedSessionId = parsedCli.sessionId || process.env.SESSION_ID || randomUUID();
  let sessionSnapshot = null;

  if (parsedCli.forkSessionId) {
    sessionSnapshot = await sessionStore.fork(parsedCli.forkSessionId, {
      id: selectedSessionId
    });
  } else {
    sessionSnapshot = await sessionStore.load(selectedSessionId);
    if (!sessionSnapshot) {
      sessionSnapshot = await sessionStore.create({
        id: selectedSessionId,
        workspaceDir
      });
    }
  }

  const telemetry = new TelemetryClient({
    endpoint: process.env.TELEMETRY_ENDPOINT,
    apiKey: process.env.TELEMETRY_API_KEY,
    orgId: env("ORG_ID", "acme"),
    engineerId: env("ENGINEER_ID", os.userInfo().username),
    teamId: process.env.TEAM_ID ?? "platform",
    projectId: process.env.PROJECT_ID ?? "starcode",
    sessionId: selectedSessionId,
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
  const contextWindowTokens = clampNumber(
    process.env.STARCODE_CONTEXT_WINDOW_TOKENS ?? process.env.MODEL_CONTEXT_WINDOW ?? 128000,
    128000,
    1
  );
  const inputCostPer1k = clampNumber(process.env.STARCODE_TOKEN_COST_INPUT_PER_1K ?? 0, 0, 0);
  const outputCostPer1k = clampNumber(process.env.STARCODE_TOKEN_COST_OUTPUT_PER_1K ?? 0, 0, 0);
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
    webSearchMaxResults: Number(process.env.STARCODE_WEB_SEARCH_MAX_RESULTS ?? 8),
    webFetchTimeoutMs: Number(process.env.STARCODE_WEB_FETCH_TIMEOUT_MS ?? 12_000),
    webFetchMaxBytes: Number(process.env.STARCODE_WEB_FETCH_MAX_BYTES ?? 300_000),
    codeSearchMaxMatches: Number(process.env.STARCODE_CODE_SEARCH_MAX_MATCHES ?? 120),
    enableCustomTools: process.env.STARCODE_ENABLE_CUSTOM_TOOLS !== "false",
    customToolDirs: parseCsv(process.env.STARCODE_CUSTOM_TOOL_DIRS || "tools")
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

  if (localTools?.setQuestionHandler instanceof Function) {
    localTools.setQuestionHandler((request) => promptQuestionAnswers({
      ...request,
      rl,
      uiMode
    }));
  }

  const permissionManager = new PermissionManager({
    store: new RuntimeApprovalStore({
      filePath: resolvePermissionStorePath()
    }),
    disabled: process.env.STARCODE_ENABLE_PERMISSION_ENGINE === "false",
    onAsk: (request) => promptPermissionDecision({
      ...request,
      rl,
      uiMode
    })
  });

  const agent = new StarcodeAgent({
    provider,
    telemetry,
    modelIoLogger,
    gitContextProvider,
    mcpManager,
    permissionManager,
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

  if (sessionSnapshot?.messages?.length) {
    agent.hydrateSessionState({
      messages: sessionSnapshot.messages,
      sessionSummary: sessionSnapshot.session_summary
    });
  }

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

  output.write(
    uiMode === UI_MODES.TUI
      ? renderTuiStartup({
          model,
          workspaceDir,
          ansiEnabled
        })
      : renderStartupPanel({
          providerName: provider.providerName,
          model,
          workspaceDir,
          sessionId: selectedSessionId,
          enableStreaming,
          enablePlanningMode,
          enableSessionSummary,
          enableCliHistory,
          mcpServerCount: runtimeMcpConfig.servers.length,
          contextWindowTokens,
          inputCostPer1k,
          outputCostPer1k,
          promptVersion,
          toolSchemaVersion,
          modelIoDebugEnabled,
          modelIoFilePath,
          uiMode
        })
  );

  let cumulativePromptTokens = 0;
  let cumulativeCompletionTokens = 0;
  let cumulativeTokens = 0;
  let cumulativeSpendUsd = 0;
  let latestTurnSnapshot = null;

  while (true) {
    const rawLine = await nextLine(
      rl,
      uiMode === UI_MODES.TUI ? renderTuiPromptLabel() : "you> "
    );
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
    if (slashCommand?.kind === "menu" || slashCommand?.kind === "help") {
      output.write(`${renderSlashHelpText()}\n`);
      continue;
    }
    if (slashCommand?.kind === "status") {
      if (!latestTurnSnapshot) {
        output.write(
          `${renderStatusWithoutTurns({
            model,
            providerName: provider.providerName,
            contextWindowTokens,
            cumulativeSpendUsd
          })}\n`
        );
      } else {
        output.write(
          `${renderTurnStats({
            model,
            providerName: provider.providerName,
            usage: latestTurnSnapshot.usage,
            latencyMs: latestTurnSnapshot.latencyMs,
            latencyBreakdown: latestTurnSnapshot.latencyBreakdown,
            traceId: latestTurnSnapshot.traceId,
            flushed: latestTurnSnapshot.flushed,
            cumulativePromptTokens,
            cumulativeCompletionTokens,
            cumulativeTokens,
            contextWindowTokens,
            cumulativeSpendUsd
          })}\n`
        );
      }
      continue;
    }
    if (slashCommand?.kind === "unknown") {
      output.write(`error> unknown slash command '/${slashCommand.command || ""}'. Type /help.\n`);
      continue;
    }

    const turnInput = slashCommand?.kind === "command" ? slashCommand.prompt : line;

    try {
      if (slashCommand?.kind === "command") {
        output.write(
          uiMode === UI_MODES.TUI
            ? `${applyStyle("workflow", ANSI.dim, ansiEnabled)} /${slashCommand.command}${
                slashCommand.args ? ` ${slashCommand.args}` : ""
              }\n`
            : `workflow> /${slashCommand.command}${slashCommand.args ? ` ${slashCommand.args}` : ""}\n`
        );
      }
      if (uiMode === UI_MODES.TUI) {
        clearSubmittedPromptEchoLine({ uiMode, isTty: Boolean(output.isTTY) });
        output.write(renderTuiHistoricalInputRow({ inputText: line, ansiEnabled }));
      }
      let streamed = false;
      let streamedText = "";
      const turn = await agent.runTurn(turnInput, {
        stream: enableStreaming,
        planning: enablePlanningMode,
        onPlan: (plan) => {
          output.write(uiMode === UI_MODES.TUI ? `${prefixLines(renderPlan(plan))}\n` : `${renderPlan(plan)}\n`);
        },
        onTextDelta: (chunk) => {
          if (!streamed) {
            output.write(uiMode === UI_MODES.TUI ? "| " : "assistant> ");
            streamed = true;
          }
          streamedText += chunk;
          output.write(uiMode === UI_MODES.TUI ? chunk.replace(/\n/g, "\n| ") : chunk);
        }
      });

      if (streamed) {
        output.write("\n");
      }

      const shouldRenderFinalOutput =
        !streamed ||
        shouldRenderFinalOutputAfterStreaming({
          streamedText,
          finalText: turn.outputText
        });

      if (shouldRenderFinalOutput) {
        if (uiMode === UI_MODES.TUI) {
          output.write(`${prefixLines(turn.outputText)}\n`);
        } else {
          output.write(`assistant> ${turn.outputText}\n`);
        }
      }

      const usage = resolveUsage(turn.usage);
      cumulativePromptTokens += usage.promptTokens;
      cumulativeCompletionTokens += usage.completionTokens;
      cumulativeTokens += usage.totalTokens;
      cumulativeSpendUsd += computeSpendUsd({
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        inputCostPer1k,
        outputCostPer1k
      });
      latestTurnSnapshot = {
        usage: turn.usage,
        latencyMs: turn.latencyMs,
        latencyBreakdown: turn.latencyBreakdown,
        traceId: turn.traceId,
        flushed: turn.flush.flushed
      };

      const state = agent.exportSessionState();
      await sessionStore.appendTurn({
        id: selectedSessionId,
        traceId: turn.traceId,
        inputText: turnInput,
        outputText: turn.outputText,
        usage: turn.usage,
        latencyMs: turn.latencyMs,
        status: "ok",
        toolCalls: turn.toolCalls,
        toolResults: turn.toolResults,
        messages: state.messages,
        sessionSummary: state.sessionSummary
      });

      if (uiMode === UI_MODES.TUI) {
        output.write(`${renderTuiTurnFooter({ model, latencyMs: turn.latencyMs, ansiEnabled })}\n`);
      }
    } catch (error) {
      output.write(`error> ${error.message}\n`);

      const state = agent.exportSessionState();
      await sessionStore.appendTurn({
        id: selectedSessionId,
        traceId: randomUUID(),
        inputText: turnInput,
        outputText: String(error?.message ?? "error"),
        usage: {},
        latencyMs: 0,
        status: "error",
        toolCalls: [],
        toolResults: [],
        messages: state.messages,
        sessionSummary: state.sessionSummary
      });
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
