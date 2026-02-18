#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {
  computeKpis,
  resolveGateThresholds,
  evaluateGate,
  createScorecard
} from "./releaseScorecard.js";

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function findLatestReport(reportDir) {
  const entries = await fs.readdir(reportDir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  if (!candidates.length) {
    throw new Error(`No report json files found in ${reportDir}`);
  }

  return path.join(reportDir, candidates[candidates.length - 1]);
}

function formatGateMarkdown(scorecard) {
  const lines = [];
  lines.push("# Starcode Release Gate Scorecard");
  lines.push("");
  lines.push(`- Generated At: ${scorecard.generated_at}`);
  lines.push(`- Run ID: ${scorecard.run.run_id}`);
  lines.push(`- Provider/Model: ${scorecard.run.provider}/${scorecard.run.model}`);
  lines.push(`- Gate Passed: ${scorecard.gate.gate_passed ? "YES" : "NO"}`);
  lines.push("");
  lines.push("| KPI | Actual | Rule | Threshold | Pass |");
  lines.push("| --- | --- | --- | --- | --- |");

  for (const check of scorecard.gate.checks) {
    lines.push(
      `| ${check.label} | ${check.actual} | ${check.comparator} | ${check.threshold} | ${check.passed ? "PASS" : "FAIL"} |`
    );
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const rootDir = path.resolve(process.env.STARCODE_EVAL_DIR ?? path.join(process.cwd(), "tmp/eval-lite"));
  const reportDir = path.resolve(process.env.STARCODE_EVAL_REPORT_DIR ?? path.join(rootDir, "reports"));
  const reportPath = process.env.STARCODE_EVAL_REPORT
    ? path.resolve(process.env.STARCODE_EVAL_REPORT)
    : await findLatestReport(reportDir);

  const scorecardDir = path.resolve(process.env.STARCODE_EVAL_SCORECARD_DIR ?? path.join(rootDir, "scorecards"));
  await fs.mkdir(scorecardDir, { recursive: true });

  const report = await readJson(reportPath);
  const kpis = computeKpis(report);
  const thresholds = resolveGateThresholds();
  const gate = evaluateGate({ kpis, thresholds });
  const scorecard = createScorecard({ report, thresholds, kpis, gate });

  const runId = report?.run_id ?? new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(scorecardDir, `${runId}.scorecard.json`);
  const latestJsonPath = path.join(scorecardDir, "latest.scorecard.json");
  const mdPath = path.join(scorecardDir, `${runId}.scorecard.md`);
  const latestMdPath = path.join(scorecardDir, "latest.scorecard.md");

  await fs.writeFile(jsonPath, `${JSON.stringify(scorecard, null, 2)}\n`, "utf8");
  await fs.writeFile(latestJsonPath, `${JSON.stringify(scorecard, null, 2)}\n`, "utf8");

  const markdown = formatGateMarkdown(scorecard);
  await fs.writeFile(mdPath, markdown, "utf8");
  await fs.writeFile(latestMdPath, markdown, "utf8");

  process.stdout.write(`Release gate evaluated for report: ${reportPath}\n`);
  process.stdout.write(`Gate passed: ${gate.gate_passed ? "yes" : "no"}\n`);
  process.stdout.write(`Scorecard JSON: ${jsonPath}\n`);
  process.stdout.write(`Scorecard Markdown: ${mdPath}\n`);

  if (!gate.gate_passed) {
    process.exit(2);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
