import { randomUUID } from "node:crypto";
import { createTelemetryEvent } from "./eventSchema.js";
import { redactSensitiveData } from "./redaction.js";
import { SpoolStore } from "./spoolStore.js";

export class TelemetryClient {
  constructor({
    endpoint,
    apiKey,
    orgId,
    engineerId,
    teamId,
    projectId,
    sessionId,
    spoolDir = ".telemetry",
    flushBatchSize = 100,
    timeoutMs = 5000,
    redact = true
  }) {
    this.endpoint = endpoint?.replace(/\/$/, "") ?? "";
    this.apiKey = apiKey ?? "";
    this.orgId = orgId;
    this.engineerId = engineerId;
    this.teamId = teamId;
    this.projectId = projectId;
    this.sessionId = sessionId ?? randomUUID();
    this.spool = new SpoolStore(spoolDir);
    this.flushBatchSize = flushBatchSize;
    this.timeoutMs = timeoutMs;
    this.redact = redact;
  }

  payload(value) {
    return this.redact ? redactSensitiveData(value) : value;
  }

  async captureSessionMeta({ traceId, mode, git, machine }) {
    const event = createTelemetryEvent({
      eventType: "session.meta",
      orgId: this.orgId,
      engineerId: this.engineerId,
      teamId: this.teamId,
      projectId: this.projectId,
      sessionId: this.sessionId,
      traceId,
      payload: this.payload({ mode, git, machine })
    });

    await this.spool.append(event);
  }

  async captureConversationTurn({
    traceId,
    request,
    response,
    model,
    tools,
    toolResults,
    usage,
    latencyMs,
    status
  }) {
    const event = createTelemetryEvent({
      eventType: "conversation.turn",
      orgId: this.orgId,
      engineerId: this.engineerId,
      teamId: this.teamId,
      projectId: this.projectId,
      sessionId: this.sessionId,
      traceId,
      payload: this.payload({
        status,
        request,
        response,
        model,
        tools,
        tool_results: toolResults,
        usage,
        latency_ms: latencyMs
      })
    });

    await this.spool.append(event);
  }

  async captureModelBehavior({
    traceId,
    provider,
    model,
    parameters,
    finishReason,
    safety,
    toolDecisions,
    toolResults,
    reasoningSummary,
    usage,
    latencyMs,
    error
  }) {
    const event = createTelemetryEvent({
      eventType: error ? "model.error" : "model.behavior",
      orgId: this.orgId,
      engineerId: this.engineerId,
      teamId: this.teamId,
      projectId: this.projectId,
      sessionId: this.sessionId,
      traceId,
      payload: this.payload({
        provider,
        model,
        parameters,
        finish_reason: finishReason,
        safety,
        tool_decisions: toolDecisions,
        tool_results: toolResults,
        reasoning_summary: reasoningSummary,
        usage,
        latency_ms: latencyMs,
        error
      })
    });

    await this.spool.append(event);
  }

  async flush(limit = this.flushBatchSize) {
    if (!this.endpoint) {
      return { flushed: 0, skipped: true, reason: "TELEMETRY_ENDPOINT not set" };
    }

    const events = await this.spool.readBatch(limit);
    if (!events.length) {
      return { flushed: 0, skipped: true, reason: "No events" };
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.endpoint}/v1/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-company-api-key": this.apiKey
        },
        body: JSON.stringify({ events }),
        signal: abortController.signal
      });

      if (!response.ok) {
        const body = await response.text();
        return {
          flushed: 0,
          skipped: false,
          reason: `ingestion rejected: ${response.status} ${body}`
        };
      }

      await this.spool.ack(events.map((event) => event.event_id));
      return { flushed: events.length, skipped: false };
    } catch (error) {
      return { flushed: 0, skipped: false, reason: error.message };
    } finally {
      clearTimeout(timeout);
    }
  }
}
