import { randomUUID } from "node:crypto";
import { createTelemetryEvent } from "./eventSchema.js";
import { redactSensitiveData } from "./redaction.js";
import { SpoolStore } from "./spoolStore.js";

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, parsed));
}

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
    redact = true,
    retryBaseMs = 1000,
    retryMaxMs = 30000,
    retryMultiplier = 2
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

    this.retryBaseMs = clampNumber(retryBaseMs, 1000, 100, 120000);
    this.retryMaxMs = clampNumber(retryMaxMs, 30000, 100, 300000);
    this.retryMultiplier = clampNumber(retryMultiplier, 2, 1.2, 10);

    this.sentCount = 0;
    this.failedCount = 0;
    this.consecutiveFailures = 0;
    this.nextRetryAt = 0;
    this.lastError = null;
    this.lastFlushAt = null;
  }

  payload(value) {
    return this.redact ? redactSensitiveData(value) : value;
  }

  async queueEvent(event) {
    await this.spool.append(event);
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

    await this.queueEvent(event);
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
    latencyBreakdown,
    status,
    contractVersions
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
        latency_ms: latencyMs,
        latency_breakdown: latencyBreakdown,
        contract_versions: contractVersions
      })
    });

    await this.queueEvent(event);
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
    contractVersions,
    usage,
    latencyMs,
    latencyBreakdown,
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
        contract_versions: contractVersions,
        usage,
        latency_ms: latencyMs,
        latency_breakdown: latencyBreakdown,
        error
      })
    });

    await this.queueEvent(event);
  }

  computeBackoffDelayMs() {
    const exponent = Math.max(0, this.consecutiveFailures - 1);
    const candidate = this.retryBaseMs * this.retryMultiplier ** exponent;
    return Math.round(Math.min(this.retryMaxMs, candidate));
  }

  async deliveryMetrics() {
    const queued = await this.spool.size();

    return {
      queued,
      sent: this.sentCount,
      failed: this.failedCount,
      consecutive_failures: this.consecutiveFailures,
      next_retry_at: this.nextRetryAt > 0 ? new Date(this.nextRetryAt).toISOString() : null,
      last_error: this.lastError,
      last_flush_at: this.lastFlushAt
    };
  }

  async flush(limit = this.flushBatchSize) {
    this.lastFlushAt = new Date().toISOString();

    if (!this.endpoint) {
      return {
        flushed: 0,
        skipped: true,
        reason: "TELEMETRY_ENDPOINT not set",
        metrics: await this.deliveryMetrics()
      };
    }

    const now = Date.now();
    if (this.nextRetryAt && now < this.nextRetryAt) {
      return {
        flushed: 0,
        skipped: true,
        reason: "retry backoff active",
        retry_after_ms: this.nextRetryAt - now,
        metrics: await this.deliveryMetrics()
      };
    }

    const events = await this.spool.readBatch(limit);
    if (!events.length) {
      return {
        flushed: 0,
        skipped: true,
        reason: "No events",
        metrics: await this.deliveryMetrics()
      };
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
        this.consecutiveFailures += 1;
        this.failedCount += events.length;
        this.lastError = `ingestion rejected: ${response.status} ${body}`;
        const delay = this.computeBackoffDelayMs();
        this.nextRetryAt = Date.now() + delay;

        return {
          flushed: 0,
          skipped: false,
          reason: this.lastError,
          retry_after_ms: delay,
          metrics: await this.deliveryMetrics()
        };
      }

      await this.spool.ack(events.map((event) => event.event_id));
      this.sentCount += events.length;
      this.consecutiveFailures = 0;
      this.nextRetryAt = 0;
      this.lastError = null;

      return {
        flushed: events.length,
        skipped: false,
        metrics: await this.deliveryMetrics()
      };
    } catch (error) {
      this.consecutiveFailures += 1;
      this.failedCount += events.length;
      this.lastError = error.message;
      const delay = this.computeBackoffDelayMs();
      this.nextRetryAt = Date.now() + delay;

      return {
        flushed: 0,
        skipped: false,
        reason: error.message,
        retry_after_ms: delay,
        metrics: await this.deliveryMetrics()
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
