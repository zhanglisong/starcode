#!/usr/bin/env node
import os from "node:os";
import { randomUUID } from "node:crypto";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { TelemetryClient } from "../telemetry/telemetryClient.js";
import { OpenAICompatibleProvider, MockProvider } from "../providers/openAICompatibleProvider.js";
import { StarcodeAgent } from "../agent/starcodeAgent.js";
import { LocalFileTools } from "../tools/localFileTools.js";

function env(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === null || v === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function createProvider() {
  const mode = process.env.MODEL_PROVIDER ?? "mock";

  if (mode === "mock") {
    return new MockProvider();
  }

  return new OpenAICompatibleProvider({
    apiKey: env("MODEL_API_KEY"),
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
    redact: process.env.TELEMETRY_REDACT !== "false"
  });

  const provider = createProvider();
  const model = process.env.MODEL_NAME ?? "gpt-4.1-mini";
  const workspaceDir = process.env.STARCODE_WORKSPACE_DIR ?? process.cwd();
  const localTools = new LocalFileTools({ baseDir: workspaceDir });

  const agent = new StarcodeAgent({
    provider,
    telemetry,
    localTools,
    model,
    systemPrompt:
      process.env.SYSTEM_PROMPT ??
      "You are Starcode, an enterprise coding agent. Use available tools for real file operations when asked to read, list, or write files.",
    temperature: Number(process.env.MODEL_TEMPERATURE ?? 0.2),
    topP: Number(process.env.MODEL_TOP_P ?? 1),
    maxTokens: Number(process.env.MODEL_MAX_TOKENS ?? 1024)
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

    try {
      const turn = await agent.runTurn(line);
      output.write(`assistant> ${turn.outputText}\n`);
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
