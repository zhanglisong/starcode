import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelIoLogger } from "../src/telemetry/modelIoLogger.js";

test("ModelIoLogger writes jsonl when enabled", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "starcode-model-io-"));
  const file = path.join(dir, "trace.jsonl");

  const logger = new ModelIoLogger({
    enabled: true,
    filePath: file
  });

  await logger.log({ phase: "model_request", trace_id: "t1" });
  await logger.log({ phase: "model_response", trace_id: "t1" });

  const raw = await fs.readFile(file, "utf8");
  const lines = raw.trim().split("\n");
  assert.equal(lines.length, 2);

  const first = JSON.parse(lines[0]);
  assert.equal(first.phase, "model_request");
  assert.equal(first.trace_id, "t1");
  assert.equal(typeof first.ts, "string");
});
