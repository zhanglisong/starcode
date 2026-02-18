import test from "node:test";
import assert from "node:assert/strict";
import { evaluateExtraChecks } from "../src/eval/runRealModelRegression.js";

test("evaluateExtraChecks validates plan/session-summary/stream/contracts", () => {
  const checks = evaluateExtraChecks({
    task: {
      require: {
        plan: true,
        sessionSummary: true,
        streamChunksMin: 2,
        contractVersions: {
          prompt: "v2",
          tool_schema: "v2"
        }
      }
    },
    turn: {
      plan: { steps: [{ id: "s1" }] },
      sessionSummary: { summary_lines: 3 },
      contractVersions: {
        prompt: "v2",
        tool_schema: "v2"
      }
    },
    streamChunks: 3
  });

  assert.equal(checks.length, 4);
  assert.equal(checks.every((item) => item.passed), true);
});

test("evaluateExtraChecks reports failures when requirements are missing", () => {
  const checks = evaluateExtraChecks({
    task: {
      require: {
        plan: true,
        streamChunksMin: 1,
        contractVersions: {
          prompt: "v2",
          tool_schema: "v2"
        }
      }
    },
    turn: {
      contractVersions: {
        prompt: "v1",
        tool_schema: "v1"
      }
    },
    streamChunks: 0
  });

  assert.equal(checks.some((item) => item.type === "plan_present" && item.passed === false), true);
  assert.equal(checks.some((item) => item.type === "stream_chunks_min" && item.passed === false), true);
  assert.equal(checks.some((item) => item.type === "contract_versions" && item.passed === false), true);
});
