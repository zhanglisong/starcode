import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  filterRecords,
  parseArgs,
  parseJsonl,
  renderOutput,
  resolveTraceId,
  runCli
} from "../src/debug/viewModelIoTrace.js";

const SAMPLE_LINES = [
  JSON.stringify({
    trace_id: "trace-a",
    phase: "model_request",
    round: 0,
    ts: "2026-02-18T00:00:00.000Z"
  }),
  JSON.stringify({
    trace_id: "trace-a",
    phase: "model_response",
    round: 0,
    ts: "2026-02-18T00:00:01.000Z"
  }),
  JSON.stringify({
    trace_id: "trace-b",
    phase: "model_request",
    round: 1,
    ts: "2026-02-18T00:00:02.000Z"
  })
];

test("parseArgs reads trace filters from argv", () => {
  const args = parseArgs([
    "--input",
    "custom.jsonl",
    "--trace-id",
    "trace-a",
    "--round",
    "0",
    "--phase",
    "model_request,model_response",
    "--format",
    "jsonl",
    "--limit",
    "2"
  ]);

  assert.equal(args.input, "custom.jsonl");
  assert.equal(args.traceId, "trace-a");
  assert.equal(args.round, 0);
  assert.deepEqual(args.phases, ["model_request", "model_response"]);
  assert.equal(args.format, "jsonl");
  assert.equal(args.limit, 2);
});

test("resolveTraceId falls back to latest trace when not provided", () => {
  const records = parseJsonl(SAMPLE_LINES.join("\n"));
  assert.equal(resolveTraceId(records, ""), "trace-b");
  assert.equal(resolveTraceId(records, "trace-a"), "trace-a");
});

test("filterRecords applies trace, round, and phase filters", () => {
  const records = parseJsonl(SAMPLE_LINES.join("\n"));
  const filtered = filterRecords(records, {
    traceId: "trace-a",
    round: 0,
    phases: ["model_response"]
  });

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].event.phase, "model_response");
});

test("renderOutput jsonl returns original raw lines", () => {
  const records = parseJsonl(SAMPLE_LINES.join("\n"));
  const filtered = filterRecords(records, {
    traceId: "trace-a",
    round: 0,
    phases: []
  });
  const output = renderOutput(filtered, "jsonl", {
    traceId: "trace-a",
    sourcePath: "x",
    filterText: "round=0"
  });

  assert.equal(output, SAMPLE_LINES.slice(0, 2).join("\n"));
});

test("runCli prints filtered records in human mode", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "starcode-trace-view-"));
  const filePath = path.join(tmpDir, "model-io.jsonl");
  await fs.writeFile(filePath, SAMPLE_LINES.join("\n"), "utf8");

  let captured = "";
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, encoding, callback) => {
    captured += String(chunk);
    if (typeof callback === "function") {
      callback();
    }
    return true;
  };

  try {
    await runCli(
      ["--input", filePath, "--trace-id", "trace-a", "--round", "0", "--phase", "model_response"],
      {},
      process.cwd()
    );
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.match(captured, /Starcode Model I\/O Trace View/);
  assert.match(captured, /trace_id=trace-a/);
  assert.match(captured, /phase=model_response/);
});
