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
    }
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
    occurred_at: event.occurred_at
  };
}
