#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { realModelRegressionTasks } from "./realModelTaskCatalog.js";
import { scoreTask } from "./scoring.js";
import { computeKpis } from "./releaseScorecard.js";
import { StarcodeAgent } from "../agent/starcodeAgent.js";
import { OpenAICompatibleProvider, MockProvider } from "../providers/openAICompatibleProvider.js";
import { LocalFileTools } from "../tools/localFileTools.js";
import { GitContextProvider } from "../context/gitContextProvider.js";

function env(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === null || value === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
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

function parseMaxToolRounds(value, fallback = Infinity) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return fallback;
    }
    if (normalized === "infinity" || normalized === "inf" || normalized === "unlimited") {
      return Infinity;
    }
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(1, Math.round(parsed));
}

class EvalTelemetry {
  constructor() {
    this.turnByTraceId = new Map();
  }

  async captureSessionMeta() {}

  async captureConversationTurn(payload) {
    this.turnByTraceId.set(payload.traceId, payload);
  }

  async captureModelBehavior() {}

  async flush() {
    return { flushed: 0, skipped: true };
  }
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

async function resetDir(target) {
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(target, { recursive: true });
}

async function writeSetupFiles(workspaceDir, setupFiles = {}) {
  const entries = Object.entries(setupFiles);
  for (const [relative, content] of entries) {
    const absolute = path.join(workspaceDir, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, String(content), "utf8");
  }
}

function latencyStats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) {
    return { avg: 0, p50: 0, p95: 0 };
  }
  const avg = Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length);
  const at = (percentile) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentile))];
  return {
    avg,
    p50: at(0.5),
    p95: at(0.95)
  };
}

function summarizeLatencyBreakdown(tasks) {
  const measured = tasks.filter((task) => task?.latency_breakdown && !task.error);
  if (!measured.length) {
    return {
      measured_tasks: 0,
      model_ms: 0,
      tool_ms: 0,
      other_ms: 0,
      model_share_pct: 0,
      tool_share_pct: 0,
      other_share_pct: 0
    };
  }

  const modelMs = measured.reduce((sum, task) => sum + Number(task.latency_breakdown.model_ms ?? 0), 0);
  const toolMs = measured.reduce((sum, task) => sum + Number(task.latency_breakdown.tool_ms ?? 0), 0);
  const otherMs = measured.reduce((sum, task) => sum + Number(task.latency_breakdown.other_ms ?? 0), 0);
  const totalMs = modelMs + toolMs + otherMs;

  if (!totalMs) {
    return {
      measured_tasks: measured.length,
      model_ms: modelMs,
      tool_ms: toolMs,
      other_ms: otherMs,
      model_share_pct: 0,
      tool_share_pct: 0,
      other_share_pct: 0
    };
  }

  return {
    measured_tasks: measured.length,
    model_ms: modelMs,
    tool_ms: toolMs,
    other_ms: otherMs,
    model_share_pct: Number(((modelMs / totalMs) * 100).toFixed(1)),
    tool_share_pct: Number(((toolMs / totalMs) * 100).toFixed(1)),
    other_share_pct: Number(((otherMs / totalMs) * 100).toFixed(1))
  };
}

function summarizeCategories(tasks) {
  const grouped = new Map();

  for (const task of tasks) {
    const category = String(task.category ?? "uncategorized");
    if (!grouped.has(category)) {
      grouped.set(category, []);
    }
    grouped.get(category).push(task);
  }

  const rows = [];
  for (const [category, list] of grouped.entries()) {
    const passed = list.filter((item) => item.passed).length;
    const total = list.length;
    const latencies = list.map((item) => item.latency_ms).filter((value) => Number.isFinite(value));

    rows.push({
      category,
      total_tasks: total,
      passed_tasks: passed,
      pass_rate: total ? Number(((passed / total) * 100).toFixed(1)) : 0,
      latency: latencyStats(latencies)
    });
  }

  return rows.sort((a, b) => a.category.localeCompare(b.category));
}

export function evaluateExtraChecks({ task, turn, streamChunks }) {
  const checks = [];
  const required = task.require ?? {};

  if (required.plan) {
    const passed = Boolean(turn?.plan && Array.isArray(turn.plan.steps) && turn.plan.steps.length > 0);
    checks.push({
      type: "plan_present",
      passed,
      detail: passed ? "Plan generated." : "Plan missing."
    });
  }

  if (required.sessionSummary) {
    const passed = Boolean(turn?.sessionSummary);
    checks.push({
      type: "session_summary_present",
      passed,
      detail: passed ? "Session summary present." : "Session summary missing."
    });
  }

  if (required.streamChunksMin !== undefined) {
    const min = Number(required.streamChunksMin ?? 0);
    const passed = Number(streamChunks ?? 0) >= min;
    checks.push({
      type: "stream_chunks_min",
      passed,
      detail: `Observed stream chunks ${streamChunks} (min ${min}).`
    });
  }

  if (required.contractVersions && typeof required.contractVersions === "object") {
    const expectedPrompt = required.contractVersions.prompt;
    const expectedTool = required.contractVersions.tool_schema;
    const actualPrompt = turn?.contractVersions?.prompt;
    const actualTool = turn?.contractVersions?.tool_schema;
    const passed = actualPrompt === expectedPrompt && actualTool === expectedTool;
    checks.push({
      type: "contract_versions",
      passed,
      detail: `Expected prompt/tool ${expectedPrompt}/${expectedTool}, got ${actualPrompt ?? "-"} / ${actualTool ?? "-"}.`
    });
  }

  return checks;
}

function formatMarkdown(report) {
  const lines = [];
  lines.push("# Starcode Real-Model Regression Report");
  lines.push("");
  lines.push(`- Run ID: ${report.run_id}`);
  lines.push(`- Started At: ${report.started_at}`);
  lines.push(`- Finished At: ${report.finished_at}`);
  lines.push(`- Provider: ${report.provider}`);
  lines.push(`- Model: ${report.model}`);
  lines.push(`- Pass Rate: ${report.pass_rate}% (${report.passed_tasks}/${report.total_tasks})`);
  lines.push(`- Latency Avg/P50/P95 (ms): ${report.latency.avg}/${report.latency.p50}/${report.latency.p95}`);
  lines.push("");
  lines.push("## Category Summary");
  lines.push("");
  lines.push("| Category | Pass | Rate | Latency Avg/P95 ms |");
  lines.push("| --- | --- | --- | --- |");
  for (const category of report.categories ?? []) {
    lines.push(
      `| ${category.category} | ${category.passed_tasks}/${category.total_tasks} | ${category.pass_rate}% | ${category.latency.avg}/${category.latency.p95} |`
    );
  }
  lines.push("");
  lines.push("## Tasks");
  lines.push("");
  lines.push("| Task ID | Category | Title | Result | Score | Latency ms | Stream Chunks | Trace ID |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");

  for (const task of report.tasks) {
    lines.push(
      `| ${task.id} | ${task.category ?? "-"} | ${task.title} | ${task.passed ? "PASS" : "FAIL"} | ${task.passed_checks}/${task.max_checks} | ${task.latency_ms ?? "-"} | ${task.stream_chunks ?? 0} | ${task.trace_id ?? "-"} |`
    );
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const provider = createProvider();
  const allowMock = process.env.STARCODE_REAL_EVAL_ALLOW_MOCK === "true";
  if (provider.providerName === "mock" && !allowMock) {
    throw new Error("Real-model regression requires non-mock provider (set MODEL_PROVIDER and keys).");
  }

  const model = process.env.MODEL_NAME ?? "gpt-4.1-mini";
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const rootDir = path.resolve(process.env.STARCODE_REAL_EVAL_DIR ?? path.join(process.cwd(), "tmp/real-model-regression"));
  const reportDir = path.join(rootDir, "reports");
  await fs.mkdir(reportDir, { recursive: true });

  const includeCategories = new Set(parseCsv(process.env.STARCODE_REAL_EVAL_CATEGORIES).map((value) => value.toLowerCase()));
  const selectedTasks = includeCategories.size
    ? realModelRegressionTasks.filter((task) => includeCategories.has(String(task.category ?? "").toLowerCase()))
    : realModelRegressionTasks;

  if (!selectedTasks.length) {
    throw new Error("No real-model regression tasks selected. Check STARCODE_REAL_EVAL_CATEGORIES filter.");
  }

  const startedAt = new Date().toISOString();
  const results = [];

  for (const task of selectedTasks) {
    const taskWorkspace = path.join(rootDir, "workspaces", task.id);
    await resetDir(taskWorkspace);
    await writeSetupFiles(taskWorkspace, task.setupFiles);

    const telemetry = new EvalTelemetry();
    const tools = new LocalFileTools({
      baseDir: taskWorkspace,
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
      baseDir: taskWorkspace,
      enabled: process.env.STARCODE_ENABLE_GIT_CONTEXT !== "false",
      timeoutMs: Number(process.env.STARCODE_GIT_CONTEXT_TIMEOUT_MS ?? 1500),
      maxChars: Number(process.env.STARCODE_GIT_CONTEXT_MAX_CHARS ?? 3000),
      maxChangedFiles: Number(process.env.STARCODE_GIT_CONTEXT_MAX_CHANGED_FILES ?? 30),
      maxStatusLines: Number(process.env.STARCODE_GIT_CONTEXT_MAX_STATUS_LINES ?? 30)
    });

    const defaults = {
      enableStreaming: process.env.STARCODE_ENABLE_STREAMING !== "false",
      enablePlanningMode: process.env.STARCODE_ENABLE_PLANNING_MODE === "true",
      enableSessionSummary: process.env.STARCODE_ENABLE_SESSION_SUMMARY !== "false",
      sessionSummaryTriggerMessages: Number(process.env.STARCODE_SESSION_SUMMARY_TRIGGER_MESSAGES ?? 18),
      sessionSummaryKeepRecent: Number(process.env.STARCODE_SESSION_SUMMARY_KEEP_RECENT ?? 8),
      promptVersion: String(process.env.STARCODE_PROMPT_VERSION ?? "v1"),
      toolSchemaVersion: String(process.env.STARCODE_TOOL_SCHEMA_VERSION ?? "v1")
    };

    const agentOverrides = task.agentOverrides ?? {};
    const runOptions = task.runOptions ?? {};

    const agent = new StarcodeAgent({
      provider,
      telemetry,
      gitContextProvider,
      localTools: tools,
      model,
      systemPrompt:
        process.env.SYSTEM_PROMPT ??
        "You are Starcode, an enterprise coding agent. Use available tools for real file operations when asked to read, list, or write files.",
      temperature: Number(process.env.MODEL_TEMPERATURE ?? 0.2),
      topP: Number(process.env.MODEL_TOP_P ?? 1),
      maxTokens: Number(process.env.MODEL_MAX_TOKENS ?? 1024),
      maxToolRounds: parseMaxToolRounds(process.env.STARCODE_MAX_TOOL_ROUNDS, Infinity),
      ...defaults,
      ...agentOverrides,
      enableStreaming: runOptions.stream === true ? true : (agentOverrides.enableStreaming ?? defaults.enableStreaming),
      enablePlanningMode:
        runOptions.planning === true ? true : (agentOverrides.enablePlanningMode ?? defaults.enablePlanningMode)
    });

    const started = Date.now();
    let streamChunks = 0;

    try {
      const preTurns = Array.isArray(task.preTurns) ? task.preTurns : [];
      for (const preTurn of preTurns) {
        await agent.runTurn(preTurn, {
          stream: false,
          planning: false
        });
      }

      const turn = await agent.runTurn(task.prompt, {
        stream: runOptions.stream === true,
        planning: runOptions.planning,
        onTextDelta: () => {
          streamChunks += 1;
        }
      });

      const event = telemetry.turnByTraceId.get(turn.traceId);
      const toolResults = event?.toolResults ?? [];
      const scored = await scoreTask({
        task,
        workspaceDir: taskWorkspace,
        assistantText: turn.outputText,
        toolResults
      });
      const extraChecks = evaluateExtraChecks({ task, turn, streamChunks });

      const allChecks = [...scored.checks, ...extraChecks];
      const passedChecks = allChecks.filter((item) => item.passed).length;
      const maxChecks = allChecks.length;
      const passed = passedChecks === maxChecks;

      const toolCallsTotal = toolResults.length;
      const toolCallsFailed = toolResults.filter((item) => item?.ok === false).length;
      const toolCallsSucceeded = Math.max(0, toolCallsTotal - toolCallsFailed);

      results.push({
        id: task.id,
        category: task.category ?? "uncategorized",
        title: task.title,
        prompt: task.prompt,
        trace_id: turn.traceId,
        latency_ms: turn.latencyMs,
        elapsed_ms: Date.now() - started,
        output_text: turn.outputText,
        usage: turn.usage,
        latency_breakdown: turn.latencyBreakdown ?? null,
        stream_chunks: streamChunks,
        passed,
        passed_checks: passedChecks,
        max_checks: maxChecks,
        checks: allChecks,
        tool_calls: toolCallsTotal,
        tool_calls_total: toolCallsTotal,
        tool_calls_succeeded: toolCallsSucceeded,
        tool_calls_failed: toolCallsFailed,
        error: null
      });
    } catch (error) {
      results.push({
        id: task.id,
        category: task.category ?? "uncategorized",
        title: task.title,
        prompt: task.prompt,
        trace_id: null,
        latency_ms: null,
        elapsed_ms: Date.now() - started,
        output_text: null,
        usage: null,
        latency_breakdown: null,
        stream_chunks: streamChunks,
        passed: false,
        passed_checks: 0,
        max_checks: (task.checks?.length ?? 0) + Object.keys(task.require ?? {}).length,
        checks: [],
        tool_calls: 0,
        tool_calls_total: 0,
        tool_calls_succeeded: 0,
        tool_calls_failed: 0,
        error: {
          name: error.name,
          message: error.message
        }
      });
    }
  }

  const finishedAt = new Date().toISOString();
  const passedTasks = results.filter((item) => item.passed).length;
  const totalTasks = results.length;
  const passRate = totalTasks ? Number(((passedTasks / totalTasks) * 100).toFixed(1)) : 0;
  const latencies = results.map((item) => item.latency_ms).filter((value) => Number.isFinite(value));

  const report = {
    run_id: runId,
    started_at: startedAt,
    finished_at: finishedAt,
    host: os.hostname(),
    provider: provider.providerName,
    model,
    total_tasks: totalTasks,
    passed_tasks: passedTasks,
    pass_rate: passRate,
    latency: latencyStats(latencies),
    latency_breakdown: summarizeLatencyBreakdown(results),
    categories: summarizeCategories(results),
    tasks: results
  };

  report.kpis = computeKpis(report);

  const jsonPath = path.join(reportDir, `${runId}.json`);
  const mdPath = path.join(reportDir, `${runId}.md`);
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(mdPath, formatMarkdown(report), "utf8");

  process.stdout.write(`Real-model regression complete.\n`);
  process.stdout.write(`Provider=${report.provider} model=${report.model}\n`);
  process.stdout.write(`Pass rate=${report.pass_rate}% (${report.passed_tasks}/${report.total_tasks})\n`);
  process.stdout.write(`Latency avg/p50/p95=${report.latency.avg}/${report.latency.p50}/${report.latency.p95} ms\n`);
  process.stdout.write(`JSON report: ${jsonPath}\n`);
  process.stdout.write(`Markdown report: ${mdPath}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack}\n`);
    process.exit(1);
  });
}
