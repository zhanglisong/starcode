import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";

const execFile = promisify(execFileCb);

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "starcode-export-"));
}

test("exportDataset writes redacted training rows and redaction coverage report", async () => {
  const dir = await makeTempDir();
  const inputDir = path.join(dir, "input");
  const outputDir = path.join(dir, "output");
  const sourceDir = path.join(inputDir, "acme", "2026-02-18");

  await fs.mkdir(sourceDir, { recursive: true });

  const event = {
    event_id: "evt-export-1",
    schema_version: 1,
    event_type: "conversation.turn",
    occurred_at: "2026-02-18T00:00:00.000Z",
    org_id: "acme",
    engineer_id: "alice",
    team_id: "platform",
    project_id: "starcode",
    session_id: "session-1",
    trace_id: "trace-1",
    payload: {
      request: { role: "user", content: "email alice@example.com and use sk-1234567890abcdefghijkl" },
      response: { role: "assistant", content: "ok" },
      model: "mock"
    }
  };

  await fs.writeFile(
    path.join(sourceDir, "conversation.turn.jsonl"),
    `${JSON.stringify(event)}\n`,
    "utf8"
  );

  await execFile("node", ["/Users/huizhang/code/starcode/src/training/exportDataset.js"], {
    env: {
      ...process.env,
      TRAINING_INPUT_DIR: inputDir,
      TRAINING_OUTPUT_DIR: outputDir,
      TRAINING_ORG_ID: "acme",
      TRAINING_REDACT: "true"
    }
  });

  const exports = await fs.readdir(outputDir, { withFileTypes: true });
  const exportDirs = exports.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.equal(exportDirs.length, 1);

  const exportPath = path.join(outputDir, exportDirs[0]);
  const sftRaw = await fs.readFile(path.join(exportPath, "sft.jsonl"), "utf8");
  assert.equal(sftRaw.includes("alice@example.com"), false);
  assert.equal(sftRaw.includes("sk-1234567890abcdefghijkl"), false);
  assert.equal(sftRaw.includes("[REDACTED_EMAIL]"), true);
  assert.equal(sftRaw.includes("[REDACTED_API_KEY]"), true);

  const coverage = JSON.parse(await fs.readFile(path.join(exportPath, "redaction-coverage.json"), "utf8"));
  assert.equal(coverage.enabled, true);
  assert.equal(coverage.total_redactions >= 2, true);
});
