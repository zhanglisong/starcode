function qualityFromFlags(flags) {
  const uniqueFlags = [...new Set(flags)];
  const score = Math.max(0, Number((1 - uniqueFlags.length * 0.15).toFixed(2)));
  return {
    ok: uniqueFlags.length === 0,
    score,
    flags: uniqueFlags
  };
}

function buildSftQuality(event, assistantText) {
  const flags = [];
  const payload = event.payload ?? {};
  const usage = payload.usage ?? {};
  const toolResults = Array.isArray(payload.toolResults) ? payload.toolResults : [];

  if (payload.status && payload.status !== "ok") {
    flags.push("turn_status_not_ok");
  }
  if (!Number.isFinite(payload.latency_ms)) {
    flags.push("missing_latency");
  }
  if (!Number.isFinite(usage.total_tokens)) {
    flags.push("missing_usage_total_tokens");
  }
  if (toolResults.some((result) => result?.ok === false)) {
    flags.push("tool_failure_present");
  }
  if (String(assistantText).trim().length < 20) {
    flags.push("short_assistant_response");
  }

  return qualityFromFlags(flags);
}

function buildBehaviorQuality(event) {
  const payload = event.payload ?? {};
  const flags = [];
  const usage = payload.usage ?? {};
  const toolResults = Array.isArray(payload.tool_results) ? payload.tool_results : [];

  if (event.event_type === "model.error" || payload.error) {
    flags.push("model_error");
  }
  if (event.event_type === "model.behavior" && !payload.finish_reason) {
    flags.push("missing_finish_reason");
  }
  if (!Number.isFinite(usage.total_tokens)) {
    flags.push("missing_usage_total_tokens");
  }
  if (!Number.isFinite(payload.latency_ms)) {
    flags.push("missing_latency");
  }
  if (toolResults.some((result) => result?.ok === false)) {
    flags.push("tool_failure_present");
  }

  return qualityFromFlags(flags);
}

export function buildSftRecord(event) {
  if (event.event_type !== "conversation.turn") {
    return null;
  }

  const user = event.payload?.request;
  const assistant = event.payload?.response;

  if (!user?.content || !assistant?.content) {
    return null;
  }

  return {
    source: "starcode-starcode",
    org_id: event.org_id,
    engineer_id: event.engineer_id,
    project_id: event.project_id,
    session_id: event.session_id,
    trace_id: event.trace_id,
    messages: [
      { role: "user", content: user.content },
      { role: "assistant", content: assistant.content }
    ],
    metadata: {
      model: event.payload?.model,
      latency_ms: event.payload?.latency_ms,
      latency_breakdown: event.payload?.latency_breakdown,
      usage: event.payload?.usage
    },
    tool_trace: {
      decisions: event.payload?.tools ?? [],
      results: event.payload?.toolResults ?? []
    },
    quality: buildSftQuality(event, assistant.content)
  };
}

export function buildBehaviorRecord(event) {
  if (event.event_type !== "model.behavior" && event.event_type !== "model.error") {
    return null;
  }

  return {
    source: "starcode-starcode",
    org_id: event.org_id,
    engineer_id: event.engineer_id,
    project_id: event.project_id,
    session_id: event.session_id,
    trace_id: event.trace_id,
    label: event.event_type,
    provider: event.payload?.provider,
    model: event.payload?.model,
    parameters: event.payload?.parameters,
    finish_reason: event.payload?.finish_reason,
    tool_decisions: event.payload?.tool_decisions,
    tool_results: event.payload?.tool_results,
    safety: event.payload?.safety,
    reasoning_summary: event.payload?.reasoning_summary,
    usage: event.payload?.usage,
    latency_ms: event.payload?.latency_ms,
    latency_breakdown: event.payload?.latency_breakdown,
    error: event.payload?.error ?? null,
    occurred_at: event.occurred_at,
    quality: buildBehaviorQuality(event)
  };
}
