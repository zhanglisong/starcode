#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { buildBehaviorRecord, buildSftRecord } from "./builders.js";
import {
  createRedactionStats,
  redactSensitiveDataWithStats,
  summarizeRedactionStats
} from "../telemetry/redaction.js";

const INPUT_DIR = process.env.TRAINING_INPUT_DIR ?? "data/ingested";
const OUTPUT_DIR = process.env.TRAINING_OUTPUT_DIR ?? "data/training";
const ORG_FILTER = process.env.TRAINING_ORG_ID ?? "";
const TRAINING_REDACT = process.env.TRAINING_REDACT !== "false";

async function readJsonl(filePath) {
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
}

async function listJsonlFiles(dir) {
  const output = [];

  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        output.push(full);
      }
    }
  }

  await walk(dir);
  return output;
}

async function writeJsonl(filePath, rows) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  if (!rows.length) {
    await fs.writeFile(filePath, "", "utf8");
    return;
  }
  await fs.writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function includeEvent(event) {
  if (!ORG_FILTER) {
    return true;
  }
  return event.org_id === ORG_FILTER;
}

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  let files = [];
  try {
    files = await listJsonlFiles(INPUT_DIR);
  } catch {
    process.stdout.write(`Input directory not found: ${INPUT_DIR}\n`);
    process.exit(1);
  }

  const sftRows = [];
  const behaviorRows = [];
  const redactionStats = createRedactionStats();

  for (const file of files) {
    const events = await readJsonl(file);
    for (const event of events) {
      const normalizedEvent = TRAINING_REDACT ? redactSensitiveDataWithStats(event, redactionStats) : event;

      if (!includeEvent(normalizedEvent)) {
        continue;
      }

      const sft = buildSftRecord(normalizedEvent);
      if (sft) {
        sftRows.push(sft);
      }

      const behavior = buildBehaviorRecord(normalizedEvent);
      if (behavior) {
        behaviorRows.push(behavior);
      }
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const exportDir = path.join(OUTPUT_DIR, stamp);

  const sftFile = path.join(exportDir, "sft.jsonl");
  const behaviorFile = path.join(exportDir, "behavior.jsonl");
  const redactionReportFile = path.join(exportDir, "redaction-coverage.json");

  await writeJsonl(sftFile, sftRows);
  await writeJsonl(behaviorFile, behaviorRows);

  const redactionSummary = summarizeRedactionStats(redactionStats);

  await fs.writeFile(
    redactionReportFile,
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        enabled: TRAINING_REDACT,
        ...redactionSummary
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const manifest = {
    generated_at: new Date().toISOString(),
    input_dir: INPUT_DIR,
    output_dir: exportDir,
    org_filter: ORG_FILTER || null,
    redaction: {
      enabled: TRAINING_REDACT,
      total_redactions: redactionSummary.total_redactions,
      coverage_file: redactionReportFile
    },
    counts: {
      sft: sftRows.length,
      behavior: behaviorRows.length
    }
  };

  await fs.writeFile(path.join(exportDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  process.stdout.write(`Export complete\n`);
  process.stdout.write(`sft=${sftRows.length} behavior=${behaviorRows.length}\n`);
  process.stdout.write(`redactions=${redactionSummary.total_redactions}\n`);
  process.stdout.write(`output=${exportDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
