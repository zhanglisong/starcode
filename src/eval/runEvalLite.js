#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { evalLiteTasks } from "./taskCatalog.js";
import { scoreTask } from "./scoring.js";
import { StarcodeAgent } from "../agent/starcodeAgent.js";
import { OpenAICompatibleProvider, MockProvider } from "../providers/openAICompatibleProvider.js";
import { LocalFileTools } from "../tools/localFileTools.js";

function env(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === null || value === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
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
  lines.push("| Task ID | Title | Result | Score | Latency ms | Model ms | Tool ms | Other ms | Trace ID |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");

  for (const task of report.tasks) {
    const breakdown = task.latency_breakdown ?? {};
    lines.push(
      `| ${task.id} | ${task.title} | ${task.passed ? "PASS" : "FAIL"} | ${task.passed_checks}/${task.max_checks} | ${task.latency_ms ?? "-"} | ${breakdown.model_ms ?? "-"} | ${breakdown.tool_ms ?? "-"} | ${breakdown.other_ms ?? "-"} | ${task.trace_id ?? "-"} |`
    );
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const provider = createProvider();
  const model = process.env.MODEL_NAME ?? "gpt-4.1-mini";
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const rootDir = path.resolve(process.env.STARCODE_EVAL_DIR ?? path.join(process.cwd(), "tmp/eval-lite"));
  const reportDir = path.join(rootDir, "reports");
  await fs.mkdir(reportDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const results = [];

  for (const task of evalLiteTasks) {
    const taskWorkspace = path.join(rootDir, "workspaces", task.id);
    await resetDir(taskWorkspace);
    await writeSetupFiles(taskWorkspace, task.setupFiles);

    const telemetry = new EvalTelemetry();
    const tools = new LocalFileTools({ baseDir: taskWorkspace });

    const agent = new StarcodeAgent({
      provider,
      telemetry,
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

      results.push({
        id: task.id,
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
        tool_calls: toolResults.length,
        error: null
      });
    } catch (error) {
      results.push({
        id: task.id,
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
    tasks: results
  };

  const jsonPath = path.join(reportDir, `${runId}.json`);
  const mdPath = path.join(reportDir, `${runId}.md`);

  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(mdPath, formatMarkdown(report), "utf8");

  process.stdout.write(`Eval-lite complete.\n`);
  process.stdout.write(`Provider=${report.provider} model=${report.model}\n`);
  process.stdout.write(`Pass rate=${report.pass_rate}% (${report.passed_tasks}/${report.total_tasks})\n`);
  process.stdout.write(`Latency avg/p50/p95=${report.latency.avg}/${report.latency.p50}/${report.latency.p95} ms\n`);
  process.stdout.write(
    `Latency breakdown total model/tool/other=${report.latency_breakdown.model_ms}/${report.latency_breakdown.tool_ms}/${report.latency_breakdown.other_ms} ms\n`
  );
  process.stdout.write(`JSON report: ${jsonPath}\n`);
  process.stdout.write(`Markdown report: ${mdPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
