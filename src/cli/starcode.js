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

function createProvider() {
  const mode = String(process.env.MODEL_PROVIDER ?? "mock").toLowerCase();

  if (mode === "mock") {
    return new MockProvider();
  }

  const apiKey = mode === "ollama" ? process.env.MODEL_API_KEY ?? "ollama" : env("MODEL_API_KEY");

  return new OpenAICompatibleProvider({
    apiKey,
    endpoint: process.env.MODEL_ENDPOINT,
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

async function main() {
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

  const provider = createProvider();
  const model = process.env.MODEL_NAME ?? "gpt-4.1-mini";
  const workspaceDir = process.env.STARCODE_WORKSPACE_DIR ?? process.cwd();
  const enableStreaming = process.env.STARCODE_ENABLE_STREAMING !== "false";
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
  const modelIoLogger = new ModelIoLogger({
    enabled: modelIoDebugEnabled,
    filePath: modelIoFilePath
  });

  const agent = new StarcodeAgent({
    provider,
    telemetry,
    modelIoLogger,
    gitContextProvider,
    localTools,
    model,
    systemPrompt:
      process.env.SYSTEM_PROMPT ??
      "You are Starcode, an enterprise coding agent. Use available tools for real file operations when asked to read, list, or write files.",
    temperature: Number(process.env.MODEL_TEMPERATURE ?? 0.2),
    topP: Number(process.env.MODEL_TOP_P ?? 1),
    maxTokens: Number(process.env.MODEL_MAX_TOKENS ?? 1024),
    enableStreaming
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

  const rl = readline.createInterface({ input, output });
  output.write("Starcode CLI (type 'exit' to quit).\n");
  if (modelIoDebugEnabled) {
    output.write(`model_io_debug=on file=${modelIoFilePath}\n`);
  }
  output.write(`streaming=${enableStreaming ? "on" : "off"}\n`);
  output.write("Use /help for workflow commands (/fix, /test, /explain, /commit).\n");

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
      output.write(`trace_id=${turn.traceId} latency_ms=${turn.latencyMs} flushed=${turn.flush.flushed}\n`);
    } catch (error) {
      output.write(`error> ${error.message}\n`);
    }
  }

  await telemetry.flush(1000);
  rl.close();
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
