import { randomUUID } from "node:crypto";

export const EVENT_TYPES = new Set([
  "session.meta",
  "conversation.turn",
  "model.behavior",
  "model.error"
]);

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

export function createTelemetryEvent({
  eventType,
  orgId,
  engineerId,
  teamId,
  projectId,
  sessionId,
  traceId,
  payload
}) {
  if (!EVENT_TYPES.has(eventType)) {
    throw new Error(`Unsupported event type: ${eventType}`);
  }

  if (!nonEmpty(orgId) || !nonEmpty(engineerId) || !nonEmpty(projectId)) {
    throw new Error("orgId, engineerId, and projectId are required");
  }

  if (!nonEmpty(sessionId) || !nonEmpty(traceId)) {
    throw new Error("sessionId and traceId are required");
  }

  if (!payload || typeof payload !== "object") {
    throw new Error("payload must be an object");
  }

  return {
    event_id: randomUUID(),
    schema_version: 1,
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    org_id: orgId,
    engineer_id: engineerId,
    team_id: teamId ?? "unknown",
    project_id: projectId,
    session_id: sessionId,
    trace_id: traceId,
    payload
  };
}

export function isValidEvent(event) {
  if (!event || typeof event !== "object") {
    return false;
  }

  if (!nonEmpty(event.event_id) || !EVENT_TYPES.has(event.event_type)) {
    return false;
  }

  if (!nonEmpty(event.org_id) || !nonEmpty(event.engineer_id)) {
    return false;
  }

  if (!nonEmpty(event.project_id) || !nonEmpty(event.session_id) || !nonEmpty(event.trace_id)) {
    return false;
  }

  return !!event.payload && typeof event.payload === "object";
}
