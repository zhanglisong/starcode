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
  const events = [];
  let malformedRows = 0;

  for (const line of raw.split("\n").map((value) => value.trim()).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        events.push(parsed);
      } else {
        malformedRows += 1;
      }
    } catch {
      malformedRows += 1;
    }
  }

  return {
    events,
    malformedRows
  };
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
  const counters = {
    files_scanned: files.length,
    events_seen: 0,
    malformed_rows: 0,
    filtered_out: 0,
    dropped_sft: 0,
    dropped_behavior: 0
  };

  for (const file of files) {
    const { events, malformedRows } = await readJsonl(file);
    counters.malformed_rows += malformedRows;

    for (const event of events) {
      counters.events_seen += 1;
      const normalizedEvent = TRAINING_REDACT ? redactSensitiveDataWithStats(event, redactionStats) : event;

      if (!includeEvent(normalizedEvent)) {
        counters.filtered_out += 1;
        continue;
      }

      const sft = buildSftRecord(normalizedEvent);
      if (sft) {
        sftRows.push(sft);
      } else if (normalizedEvent.event_type === "conversation.turn") {
        counters.dropped_sft += 1;
      }

      const behavior = buildBehaviorRecord(normalizedEvent);
      if (behavior) {
        behaviorRows.push(behavior);
      } else if (normalizedEvent.event_type === "model.behavior" || normalizedEvent.event_type === "model.error") {
        counters.dropped_behavior += 1;
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
      behavior: behaviorRows.length,
      malformed_rows: counters.malformed_rows,
      filtered_out: counters.filtered_out,
      dropped_sft: counters.dropped_sft,
      dropped_behavior: counters.dropped_behavior
    },
    counters
  };

  await fs.writeFile(path.join(exportDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  process.stdout.write(`Export complete\n`);
  process.stdout.write(`sft=${sftRows.length} behavior=${behaviorRows.length}\n`);
  process.stdout.write(`malformed_rows=${counters.malformed_rows} filtered_out=${counters.filtered_out}\n`);
  process.stdout.write(`dropped_sft=${counters.dropped_sft} dropped_behavior=${counters.dropped_behavior}\n`);
  process.stdout.write(`redactions=${redactionSummary.total_redactions}\n`);
  process.stdout.write(`output=${exportDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
