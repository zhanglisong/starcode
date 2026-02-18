function toNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

export function computeKpis(report) {
  const tasks = Array.isArray(report?.tasks) ? report.tasks : [];
  const totalTasks = Number(report?.total_tasks ?? tasks.length ?? 0);
  const passedTasks = Number(report?.passed_tasks ?? tasks.filter((item) => item?.passed).length ?? 0);
  const taskSuccessPct = totalTasks ? Number(((passedTasks / totalTasks) * 100).toFixed(1)) : 0;
  const taskFailurePct = Number((100 - taskSuccessPct).toFixed(1));

  const toolTotals = tasks.reduce(
    (acc, task) => {
      const total = Number(task?.tool_calls_total ?? task?.tool_calls ?? 0);
      const failed = Number(task?.tool_calls_failed ?? 0);
      const succeeded = Number(task?.tool_calls_succeeded ?? Math.max(0, total - failed));

      return {
        total: acc.total + Math.max(0, total),
        failed: acc.failed + Math.max(0, failed),
        succeeded: acc.succeeded + Math.max(0, succeeded)
      };
    },
    { total: 0, failed: 0, succeeded: 0 }
  );

  const toolSuccessPct = toolTotals.total
    ? Number(((toolTotals.succeeded / toolTotals.total) * 100).toFixed(1))
    : 100;
  const toolFailurePct = toolTotals.total ? Number(((toolTotals.failed / toolTotals.total) * 100).toFixed(1)) : 0;

  return {
    task_success_pct: taskSuccessPct,
    task_failure_pct: taskFailurePct,
    tool_success_pct: toolSuccessPct,
    tool_failure_pct: toolFailurePct,
    latency_p95_ms: Number(report?.latency?.p95 ?? 0),
    latency_avg_ms: Number(report?.latency?.avg ?? 0),
    total_tasks: totalTasks,
    passed_tasks: passedTasks,
    failed_tasks: Math.max(0, totalTasks - passedTasks),
    total_tool_calls: toolTotals.total,
    failed_tool_calls: toolTotals.failed
  };
}

export function resolveGateThresholds(source = process.env) {
  return {
    min_task_success_pct: toNumber(source.STARCODE_GATE_MIN_TASK_SUCCESS_PCT, 80),
    min_tool_success_pct: toNumber(source.STARCODE_GATE_MIN_TOOL_SUCCESS_PCT, 90),
    max_task_failure_pct: toNumber(source.STARCODE_GATE_MAX_TASK_FAILURE_PCT, 20),
    max_tool_failure_pct: toNumber(source.STARCODE_GATE_MAX_TOOL_FAILURE_PCT, 10),
    max_latency_p95_ms: toNumber(source.STARCODE_GATE_MAX_LATENCY_P95_MS, 30000)
  };
}

export function evaluateGate({ kpis, thresholds }) {
  const checks = [
    {
      key: "task_success_pct",
      label: "Task Success %",
      comparator: ">=",
      actual: kpis.task_success_pct,
      threshold: thresholds.min_task_success_pct,
      passed: kpis.task_success_pct >= thresholds.min_task_success_pct
    },
    {
      key: "tool_success_pct",
      label: "Tool Success %",
      comparator: ">=",
      actual: kpis.tool_success_pct,
      threshold: thresholds.min_tool_success_pct,
      passed: kpis.tool_success_pct >= thresholds.min_tool_success_pct
    },
    {
      key: "task_failure_pct",
      label: "Task Failure %",
      comparator: "<=",
      actual: kpis.task_failure_pct,
      threshold: thresholds.max_task_failure_pct,
      passed: kpis.task_failure_pct <= thresholds.max_task_failure_pct
    },
    {
      key: "tool_failure_pct",
      label: "Tool Failure %",
      comparator: "<=",
      actual: kpis.tool_failure_pct,
      threshold: thresholds.max_tool_failure_pct,
      passed: kpis.tool_failure_pct <= thresholds.max_tool_failure_pct
    },
    {
      key: "latency_p95_ms",
      label: "Latency P95 ms",
      comparator: "<=",
      actual: kpis.latency_p95_ms,
      threshold: thresholds.max_latency_p95_ms,
      passed: kpis.latency_p95_ms <= thresholds.max_latency_p95_ms
    }
  ];

  return {
    gate_passed: checks.every((check) => check.passed),
    checks
  };
}

export function createScorecard({ report, thresholds, kpis, gate }) {
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    run: {
      run_id: report?.run_id ?? null,
      started_at: report?.started_at ?? null,
      finished_at: report?.finished_at ?? null,
      provider: report?.provider ?? null,
      model: report?.model ?? null
    },
    thresholds,
    kpis,
    gate
  };
}
