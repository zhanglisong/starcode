#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { evalLiteTasks } from "./taskCatalog.js";
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

function formatMarkdown(report) {
  const lines = [];
  lines.push("# Starcode Eval-Lite Report");
  lines.push("");
  lines.push(`- Run ID: ${report.run_id}`);
  lines.push(`- Started At: ${report.started_at}`);
  lines.push(`- Finished At: ${report.finished_at}`);
  lines.push(`- Provider: ${report.provider}`);
  lines.push(`- Model: ${report.model}`);
  lines.push(`- Pass Rate: ${report.pass_rate}% (${report.passed_tasks}/${report.total_tasks})`);
  lines.push(`- Latency Avg/P50/P95 (ms): ${report.latency.avg}/${report.latency.p50}/${report.latency.p95}`);
  lines.push(
    `- Latency Breakdown Total (ms): model=${report.latency_breakdown.model_ms} tool=${report.latency_breakdown.tool_ms} other=${report.latency_breakdown.other_ms}`
  );
  lines.push(
    `- Latency Breakdown Share: model=${report.latency_breakdown.model_share_pct}% tool=${report.latency_breakdown.tool_share_pct}% other=${report.latency_breakdown.other_share_pct}%`
  );
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
  lines.push("| Task ID | Category | Title | Result | Score | Latency ms | Model ms | Tool ms | Other ms | Trace ID |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");

  for (const task of report.tasks) {
    const breakdown = task.latency_breakdown ?? {};
    lines.push(
      `| ${task.id} | ${task.category ?? "-"} | ${task.title} | ${task.passed ? "PASS" : "FAIL"} | ${task.passed_checks}/${task.max_checks} | ${task.latency_ms ?? "-"} | ${breakdown.model_ms ?? "-"} | ${breakdown.tool_ms ?? "-"} | ${breakdown.other_ms ?? "-"} | ${task.trace_id ?? "-"} |`
    );
  }

  return `${lines.join("\n")}\n`;
}

async function readJsonlSafe(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function summarizeNightly(historyRows) {
  const grouped = new Map();

  for (const row of historyRows) {
    const provider = String(row.provider ?? "unknown");
    const model = String(row.model ?? "unknown");
    const key = `${provider}::${model}`;

    if (!grouped.has(key)) {
      grouped.set(key, {
        provider,
        model,
        runs: 0,
        pass_rates: [],
        latency_avgs: [],
        latency_p95s: [],
        latest_at: row.finished_at ?? row.started_at ?? null,
        latest_pass_rate: Number(row.pass_rate ?? 0),
        latest_latency_avg: Number(row.latency_avg ?? 0),
        latest_latency_p95: Number(row.latency_p95 ?? 0)
      });
    }

    const entry = grouped.get(key);
    entry.runs += 1;
    entry.pass_rates.push(Number(row.pass_rate ?? 0));
    entry.latency_avgs.push(Number(row.latency_avg ?? 0));
    entry.latency_p95s.push(Number(row.latency_p95 ?? 0));

    const rowDate = Date.parse(row.finished_at ?? row.started_at ?? "");
    const latestDate = Date.parse(entry.latest_at ?? "");
    if (!Number.isFinite(latestDate) || (Number.isFinite(rowDate) && rowDate > latestDate)) {
      entry.latest_at = row.finished_at ?? row.started_at ?? entry.latest_at;
      entry.latest_pass_rate = Number(row.pass_rate ?? 0);
      entry.latest_latency_avg = Number(row.latency_avg ?? 0);
      entry.latest_latency_p95 = Number(row.latency_p95 ?? 0);
    }
  }

  return [...grouped.values()]
    .map((entry) => {
      const avg = (values) => (values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1)) : 0);
      return {
        provider: entry.provider,
        model: entry.model,
        runs: entry.runs,
        latest_at: entry.latest_at,
        latest_pass_rate: entry.latest_pass_rate,
        latest_latency_avg: entry.latest_latency_avg,
        latest_latency_p95: entry.latest_latency_p95,
        avg_pass_rate: avg(entry.pass_rates),
        avg_latency_avg: avg(entry.latency_avgs),
        avg_latency_p95: avg(entry.latency_p95s),
        best_pass_rate: entry.pass_rates.length ? Number(Math.max(...entry.pass_rates).toFixed(1)) : 0
      };
    })
    .sort((a, b) => b.latest_pass_rate - a.latest_pass_rate || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}

function formatNightlyMarkdown(rows) {
  const lines = [];
  lines.push("# Starcode Eval Nightly Summary");
  lines.push("");
  lines.push("| Provider | Model | Runs | Latest Pass % | Latest Latency Avg/P95 ms | Avg Pass % | Avg Latency Avg/P95 ms | Best Pass % | Latest Run |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");

  for (const row of rows) {
    lines.push(
      `| ${row.provider} | ${row.model} | ${row.runs} | ${row.latest_pass_rate}% | ${row.latest_latency_avg}/${row.latest_latency_p95} | ${row.avg_pass_rate}% | ${row.avg_latency_avg}/${row.avg_latency_p95} | ${row.best_pass_rate}% | ${row.latest_at ?? "-"} |`
    );
  }

  return `${lines.join("\n")}\n`;
}

async function updateNightlyHistory({ rootDir, report }) {
  const historyDir = path.join(rootDir, "history");
  await fs.mkdir(historyDir, { recursive: true });

  const historyFile = path.join(historyDir, "nightly.jsonl");
  const summaryFile = path.join(historyDir, "nightly-summary.md");

  const entry = {
    run_id: report.run_id,
    started_at: report.started_at,
    finished_at: report.finished_at,
    provider: report.provider,
    model: report.model,
    total_tasks: report.total_tasks,
    passed_tasks: report.passed_tasks,
    pass_rate: report.pass_rate,
    latency_avg: report.latency?.avg ?? 0,
    latency_p95: report.latency?.p95 ?? 0,
    tool_success_pct: report.kpis?.tool_success_pct ?? 0,
    task_failure_pct: report.kpis?.task_failure_pct ?? 0
  };

  await fs.appendFile(historyFile, `${JSON.stringify(entry)}\n`, "utf8");

  const rows = await readJsonlSafe(historyFile);
  const summaryRows = summarizeNightly(rows);
  await fs.writeFile(summaryFile, formatNightlyMarkdown(summaryRows), "utf8");

  return {
    history_file: historyFile,
    summary_file: summaryFile
  };
}

async function main() {
  const provider = createProvider();
  const model = process.env.MODEL_NAME ?? "gpt-4.1-mini";
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const rootDir = path.resolve(process.env.STARCODE_EVAL_DIR ?? path.join(process.cwd(), "tmp/eval-lite"));
  const reportDir = path.join(rootDir, "reports");
  await fs.mkdir(reportDir, { recursive: true });

  const includeCategories = new Set(parseCsv(process.env.STARCODE_EVAL_CATEGORIES).map((value) => value.toLowerCase()));
  const selectedTasks = includeCategories.size
    ? evalLiteTasks.filter((task) => includeCategories.has(String(task.category ?? "").toLowerCase()))
    : evalLiteTasks;

  if (!selectedTasks.length) {
    throw new Error("No eval tasks selected. Check STARCODE_EVAL_CATEGORIES filter.");
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
      maxToolRounds: Number(process.env.STARCODE_MAX_TOOL_ROUNDS ?? 5)
    });

    const started = Date.now();

    try {
      const turn = await agent.runTurn(task.prompt);
      const event = telemetry.turnByTraceId.get(turn.traceId);
      const toolResults = event?.toolResults ?? [];
      const scored = await scoreTask({
        task,
        workspaceDir: taskWorkspace,
        assistantText: turn.outputText,
        toolResults
      });

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
        passed: scored.passed,
        passed_checks: scored.passedChecks,
        max_checks: scored.maxChecks,
        checks: scored.checks,
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
        passed: false,
        passed_checks: 0,
        max_checks: task.checks?.length ?? 0,
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
  const categorySummary = summarizeCategories(results);

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
    categories: categorySummary,
    tasks: results
  };

  const kpis = computeKpis(report);
  report.kpis = kpis;

  const jsonPath = path.join(reportDir, `${runId}.json`);
  const mdPath = path.join(reportDir, `${runId}.md`);

  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(mdPath, formatMarkdown(report), "utf8");

  const historyEnabled = process.env.STARCODE_EVAL_WRITE_HISTORY !== "false";
  const history = historyEnabled ? await updateNightlyHistory({ rootDir, report }) : null;

  process.stdout.write(`Eval-lite complete.\n`);
  process.stdout.write(`Provider=${report.provider} model=${report.model}\n`);
  process.stdout.write(`Pass rate=${report.pass_rate}% (${report.passed_tasks}/${report.total_tasks})\n`);
  process.stdout.write(`Latency avg/p50/p95=${report.latency.avg}/${report.latency.p50}/${report.latency.p95} ms\n`);
  process.stdout.write(
    `Latency breakdown total model/tool/other=${report.latency_breakdown.model_ms}/${report.latency_breakdown.tool_ms}/${report.latency_breakdown.other_ms} ms\n`
  );
  process.stdout.write(`JSON report: ${jsonPath}\n`);
  process.stdout.write(`Markdown report: ${mdPath}\n`);
  if (history) {
    process.stdout.write(`Nightly history: ${history.history_file}\n`);
    process.stdout.write(`Nightly summary: ${history.summary_file}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
