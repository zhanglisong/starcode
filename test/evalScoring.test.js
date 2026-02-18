import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scoreTask } from "../src/eval/scoring.js";

test("scoreTask passes file and response checks when expectations match", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "starcode-eval-score-"));
  await fs.mkdir(path.join(workspace, "notes"), { recursive: true });
  await fs.writeFile(path.join(workspace, "notes", "x.txt"), "hello", "utf8");

  const task = {
    checks: [
      { type: "file_equals", path: "notes/x.txt", expected: "hello" },
      { type: "response_contains", expected: "done" },
      { type: "min_tool_calls", min: 1 }
    ]
  };

  const result = await scoreTask({
    task,
    workspaceDir: workspace,
    assistantText: "Done and completed.",
    toolResults: [{ ok: true }]
  });

  assert.equal(result.passed, true);
  assert.equal(result.passedChecks, 3);
  assert.equal(result.maxChecks, 3);
});

test("scoreTask fails when file is missing", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "starcode-eval-score-"));

  const task = {
    checks: [{ type: "file_equals", path: "missing.txt", expected: "x" }]
  };

  const result = await scoreTask({
    task,
    workspaceDir: workspace,
    assistantText: "n/a",
    toolResults: []
  });

  assert.equal(result.passed, false);
  assert.equal(result.passedChecks, 0);
  assert.equal(result.maxChecks, 1);
});
