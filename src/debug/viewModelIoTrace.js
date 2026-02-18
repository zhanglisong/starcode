#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function parseCsv(value) {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseArgs(argv, env = process.env) {
  const options = {
    input: env.STARCODE_MODEL_IO_INPUT ?? ".telemetry/model-io.jsonl",
    traceId: env.TRACE_ID ?? "",
    round: null,
    phases: parseCsv(env.STARCODE_TRACE_PHASE),
    format: String(env.STARCODE_TRACE_FORMAT ?? "human").toLowerCase(),
    limit: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];

    switch (token) {
      case "--input":
        options.input = next ?? options.input;
        i += 1;
        break;
      case "--trace-id":
        options.traceId = next ?? options.traceId;
        i += 1;
        break;
      case "--round":
        options.round = Number(next);
        i += 1;
        break;
      case "--phase":
        options.phases = parseCsv(next);
        i += 1;
        break;
      case "--format":
        options.format = String(next ?? options.format).toLowerCase();
        i += 1;
        break;
      case "--limit":
        options.limit = Number(next);
        i += 1;
        break;
      default:
        break;
    }
  }

  if (Number.isNaN(options.round)) {
    throw new Error("Invalid --round value (must be a number)");
  }
  if (!["human", "json", "jsonl"].includes(options.format)) {
    throw new Error("Invalid --format value (must be one of: human, json, jsonl)");
  }
  if (options.limit !== null && (!Number.isFinite(options.limit) || options.limit <= 0)) {
    throw new Error("Invalid --limit value (must be a positive number)");
  }

  return options;
}

export function parseJsonl(raw) {
  return raw
    .split("\n")
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter((row) => Boolean(row.line))
    .flatMap((row) => {
      try {
        return [{ raw: row.line, lineNumber: row.lineNumber, event: JSON.parse(row.line) }];
      } catch {
        return [];
      }
    });
}

export function resolveTraceId(records, requestedTraceId = "") {
  if (requestedTraceId) {
    return requestedTraceId;
  }
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const traceId = records[i]?.event?.trace_id;
    if (traceId) {
      return traceId;
    }
  }
  return "";
}

export function filterRecords(records, { traceId, round = null, phases = [] }) {
  return records.filter(({ event }) => {
    if (traceId && event.trace_id !== traceId) {
      return false;
    }
    if (round !== null && event.round !== round) {
      return false;
    }
    if (phases.length > 0 && !phases.includes(event.phase)) {
      return false;
    }
    return true;
  });
}

export function renderHuman(records, metadata) {
  const header = [
    "Starcode Model I/O Trace View",
    `trace_id=${metadata.traceId}`,
    `source=${metadata.sourcePath}`,
    `filters=${metadata.filterText}`,
    `events=${records.length}`,
    ""
  ];

  const body = records.map(({ event, lineNumber }) => {
    const summary = [
      `[line ${lineNumber}]`,
      `ts=${event.ts ?? "-"}`,
      `phase=${event.phase ?? "-"}`,
      `round=${event.round ?? "-"}`
    ].join(" ");
    return `${summary}\n${JSON.stringify(event, null, 2)}`;
  });

  return [...header, ...body].join("\n\n");
}

export function renderOutput(records, format, metadata) {
  if (format === "jsonl") {
    return records.map((row) => row.raw).join("\n");
  }
  if (format === "json") {
    return JSON.stringify(
      {
        trace_id: metadata.traceId,
        source: metadata.sourcePath,
        filters: metadata.filterText,
        events: records.map((row) => row.event)
      },
      null,
      2
    );
  }
  return renderHuman(records, metadata);
}

export async function runCli(argv = process.argv.slice(2), env = process.env, cwd = process.cwd()) {
  const options = parseArgs(argv, env);
  const inputPath = path.isAbsolute(options.input) ? options.input : path.resolve(cwd, options.input);
  const raw = await fs.readFile(inputPath, "utf8");
  const records = parseJsonl(raw);

  if (records.length === 0) {
    throw new Error(`No JSONL model I/O records found in ${inputPath}`);
  }

  const traceId = resolveTraceId(records, options.traceId);
  if (!traceId) {
    throw new Error("Could not resolve trace_id from model I/O records");
  }

  const phases = options.phases;
  const filterText = [
    `round=${options.round === null ? "*" : options.round}`,
    `phase=${phases.length ? phases.join(",") : "*"}`,
    `trace_id=${traceId}`
  ].join(" ");

  let filtered = filterRecords(records, { traceId, round: options.round, phases });
  if (options.limit !== null && filtered.length > options.limit) {
    filtered = filtered.slice(filtered.length - options.limit);
  }

  if (filtered.length === 0) {
    throw new Error(`No records matched filters: ${filterText}`);
  }

  const output = renderOutput(filtered, options.format, {
    traceId,
    sourcePath: inputPath,
    filterText
  });
  process.stdout.write(`${output}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`${error.stack}\n`);
    process.exit(1);
  });
}
