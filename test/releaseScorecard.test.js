import test from "node:test";
import assert from "node:assert/strict";
import {
  computeKpis,
  resolveGateThresholds,
  evaluateGate,
  createScorecard
} from "../src/eval/releaseScorecard.js";

test("computeKpis derives task/tool success and latency KPIs", () => {
  const report = {
    total_tasks: 4,
    passed_tasks: 3,
    latency: {
      avg: 1200,
      p95: 2200
    },
    tasks: [
      { tool_calls_total: 2, tool_calls_failed: 0, tool_calls_succeeded: 2, passed: true },
      { tool_calls_total: 1, tool_calls_failed: 1, tool_calls_succeeded: 0, passed: false },
      { tool_calls_total: 0, tool_calls_failed: 0, tool_calls_succeeded: 0, passed: true },
      { tool_calls_total: 1, tool_calls_failed: 0, tool_calls_succeeded: 1, passed: true }
    ]
  };

  const kpis = computeKpis(report);

  assert.equal(kpis.task_success_pct, 75);
  assert.equal(kpis.task_failure_pct, 25);
  assert.equal(kpis.tool_success_pct, 75);
  assert.equal(kpis.tool_failure_pct, 25);
  assert.equal(kpis.latency_p95_ms, 2200);
  assert.equal(kpis.total_tool_calls, 4);
  assert.equal(kpis.failed_tool_calls, 1);
});

test("evaluateGate fails when KPI thresholds are not met", () => {
  const kpis = {
    task_success_pct: 60,
    tool_success_pct: 70,
    task_failure_pct: 40,
    tool_failure_pct: 30,
    latency_p95_ms: 45000
  };

  const thresholds = {
    min_task_success_pct: 80,
    min_tool_success_pct: 90,
    max_task_failure_pct: 20,
    max_tool_failure_pct: 10,
    max_latency_p95_ms: 30000
  };

  const gate = evaluateGate({ kpis, thresholds });
  assert.equal(gate.gate_passed, false);
  assert.equal(gate.checks.filter((item) => !item.passed).length, 5);
});

test("resolveGateThresholds supports env overrides and scorecard assembly", () => {
  const thresholds = resolveGateThresholds({
    STARCODE_GATE_MIN_TASK_SUCCESS_PCT: "85",
    STARCODE_GATE_MIN_TOOL_SUCCESS_PCT: "95",
    STARCODE_GATE_MAX_TASK_FAILURE_PCT: "15",
    STARCODE_GATE_MAX_TOOL_FAILURE_PCT: "5",
    STARCODE_GATE_MAX_LATENCY_P95_MS: "15000"
  });

  assert.equal(thresholds.min_task_success_pct, 85);
  assert.equal(thresholds.min_tool_success_pct, 95);
  assert.equal(thresholds.max_task_failure_pct, 15);
  assert.equal(thresholds.max_tool_failure_pct, 5);
  assert.equal(thresholds.max_latency_p95_ms, 15000);

  const gate = evaluateGate({
    kpis: {
      task_success_pct: 90,
      tool_success_pct: 98,
      task_failure_pct: 10,
      tool_failure_pct: 2,
      latency_p95_ms: 10000
    },
    thresholds
  });

  const scorecard = createScorecard({
    report: {
      run_id: "run-1",
      provider: "moonshot",
      model: "kimi-k2.5",
      started_at: "2026-02-18T00:00:00.000Z",
      finished_at: "2026-02-18T00:10:00.000Z"
    },
    thresholds,
    kpis: {
      task_success_pct: 90,
      tool_success_pct: 98,
      task_failure_pct: 10,
      tool_failure_pct: 2,
      latency_p95_ms: 10000
    },
    gate
  });

  assert.equal(scorecard.run.run_id, "run-1");
  assert.equal(scorecard.gate.gate_passed, true);
});
