import { randomUUID } from "node:crypto";

function normalizeContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item?.type === "text" && typeof item?.text === "string") {
          return item.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (content === null || content === undefined) {
    return "";
  }

  return String(content);
}

function buildAssistantMessageFromResult(result, includeToolCalls = false) {
  const message = {
    role: "assistant",
    content: normalizeContent(result?.message?.content ?? result?.outputText)
  };

  if (result?.message?.reasoning_content !== undefined) {
    message.reasoning_content = result.message.reasoning_content;
  }

  if (includeToolCalls && result?.toolCalls?.length) {
    message.tool_calls = result.toolCalls;
  }

  return message;
}

function parseToolArguments(rawArguments) {
  if (typeof rawArguments !== "string") {
    return {};
  }

  try {
    return JSON.parse(rawArguments);
  } catch {
    return {
      _raw: rawArguments
    };
  }
}

function createLatencyBreakdown({
  totalMs,
  modelMs,
  toolMs,
  modelCalls,
  toolCalls,
  toolFailures,
  toolRounds
}) {
  const safeTotal = Number.isFinite(totalMs) ? Math.max(0, Math.round(totalMs)) : 0;
  const safeModelMs = Number.isFinite(modelMs) ? Math.max(0, Math.round(modelMs)) : 0;
  const safeToolMs = Number.isFinite(toolMs) ? Math.max(0, Math.round(toolMs)) : 0;
  const safeModelCalls = Number.isFinite(modelCalls) ? Math.max(0, modelCalls) : 0;
  const safeToolCalls = Number.isFinite(toolCalls) ? Math.max(0, toolCalls) : 0;
  const safeToolFailures = Number.isFinite(toolFailures) ? Math.max(0, toolFailures) : 0;
  const safeToolRounds = Number.isFinite(toolRounds) ? Math.max(0, toolRounds) : 0;
  const otherMs = Math.max(0, safeTotal - safeModelMs - safeToolMs);

  return {
    total_ms: safeTotal,
    model_ms: safeModelMs,
    tool_ms: safeToolMs,
    other_ms: otherMs,
    model_calls: safeModelCalls,
    tool_calls: safeToolCalls,
    tool_failures: safeToolFailures,
    tool_rounds: safeToolRounds,
    model_avg_ms: safeModelCalls ? Math.round(safeModelMs / safeModelCalls) : 0,
    tool_avg_ms: safeToolCalls ? Math.round(safeToolMs / safeToolCalls) : 0
  };
}

export class StarcodeAgent {
  constructor({
    provider,
    telemetry,
    modelIoLogger,
    localTools,
    model,
    systemPrompt,
    temperature = 0.2,
    topP = 1,
    maxTokens = 1024,
    maxToolRounds = 5
  }) {
    this.provider = provider;
    this.telemetry = telemetry;
    this.modelIoLogger = modelIoLogger;
    this.localTools = localTools;
    this.model = model;
    this.temperature = temperature;
    this.topP = topP;
    this.maxTokens = maxTokens;
    this.maxToolRounds = maxToolRounds;
    this.messages = [{ role: "system", content: systemPrompt }];
  }

  async logModelIo(event) {
    if (!this.modelIoLogger) {
      return;
    }
    await this.modelIoLogger.log(event);
  }

  async runTurn(userText) {
    const traceId = randomUUID();
    const userMessage = { role: "user", content: userText };
    this.messages.push(userMessage);

    const startedAt = Date.now();
    const allToolCalls = [];
    const allToolResults = [];
    let latestUsage = {};
    let latestFinishReason = "unknown";
    let finalAssistantText = "";
    const timing = {
      modelMs: 0,
      toolMs: 0,
      modelCalls: 0,
      toolCalls: 0,
      toolFailures: 0,
      toolRounds: 0
    };

    try {
      const tools = this.localTools?.getToolDefinitions?.() ?? [];

      for (let round = 0; round <= this.maxToolRounds; round += 1) {
        await this.logModelIo({
          phase: "model_request",
          trace_id: traceId,
          round,
          model: this.model,
          messages: this.messages,
          tools
        });

        const modelStartedAt = Date.now();
        let result;

        try {
          result = await this.provider.complete({
            model: this.model,
            messages: this.messages,
            temperature: this.temperature,
            topP: this.topP,
            maxTokens: this.maxTokens,
            tools
          });
        } finally {
          timing.modelCalls += 1;
          timing.modelMs += Date.now() - modelStartedAt;
        }

        latestUsage = result.usage ?? latestUsage;
        latestFinishReason = result.finishReason ?? latestFinishReason;

        await this.logModelIo({
          phase: "model_response",
          trace_id: traceId,
          round,
          finish_reason: result.finishReason,
          usage: result.usage,
          message: result.message ?? {
            role: "assistant",
            content: normalizeContent(result.outputText)
          },
          tool_calls: result.toolCalls ?? [],
          model_latency_ms: Date.now() - modelStartedAt
        });

        if (!result.toolCalls?.length || !this.localTools) {
          const assistantMessage = buildAssistantMessageFromResult(result, false);
          finalAssistantText = assistantMessage.content;
          this.messages.push(assistantMessage);
          break;
        }

        timing.toolRounds += 1;
        allToolCalls.push(...result.toolCalls);
        this.messages.push(buildAssistantMessageFromResult(result, true));

        for (const call of result.toolCalls) {
          const toolStartedAt = Date.now();
          const toolName = call?.function?.name ?? "unknown";
          const parsedArguments = parseToolArguments(call?.function?.arguments);

          await this.logModelIo({
            phase: "tool_start",
            trace_id: traceId,
            round,
            tool_call_id: call?.id ?? null,
            name: toolName,
            arguments: parsedArguments
          });

          try {
            const toolResult = await this.localTools.executeToolCall(call);
            const toolDurationMs = Date.now() - toolStartedAt;
            timing.toolMs += toolDurationMs;
            timing.toolCalls += 1;

            allToolResults.push({
              tool_call_id: call?.id ?? null,
              name: toolName,
              arguments: parsedArguments,
              ok: true,
              result: toolResult,
              duration_ms: toolDurationMs
            });

            await this.logModelIo({
              phase: "tool_result",
              trace_id: traceId,
              round,
              tool_call_id: call?.id ?? null,
              name: toolName,
              ok: true,
              result: toolResult,
              duration_ms: toolDurationMs
            });

            this.messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify(toolResult)
            });
          } catch (error) {
            const toolDurationMs = Date.now() - toolStartedAt;
            timing.toolMs += toolDurationMs;
            timing.toolCalls += 1;
            timing.toolFailures += 1;

            allToolResults.push({
              tool_call_id: call?.id ?? null,
              name: toolName,
              arguments: parsedArguments,
              ok: false,
              error: error.message,
              duration_ms: toolDurationMs
            });

            await this.logModelIo({
              phase: "tool_result",
              trace_id: traceId,
              round,
              tool_call_id: call?.id ?? null,
              name: toolName,
              ok: false,
              error: error.message,
              duration_ms: toolDurationMs
            });

            this.messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify({
                ok: false,
                error: error.message
              })
            });
          }
        }

        if (round === this.maxToolRounds) {
          finalAssistantText = "Tool-call round limit reached before final response.";
          this.messages.push({ role: "assistant", content: finalAssistantText });
        }
      }

      const latencyMs = Date.now() - startedAt;
      const latencyBreakdown = createLatencyBreakdown({
        totalMs: latencyMs,
        modelMs: timing.modelMs,
        toolMs: timing.toolMs,
        modelCalls: timing.modelCalls,
        toolCalls: timing.toolCalls,
        toolFailures: timing.toolFailures,
        toolRounds: timing.toolRounds
      });
      const assistantMessage = { role: "assistant", content: finalAssistantText };

      await this.telemetry.captureConversationTurn({
        traceId,
        request: userMessage,
        response: assistantMessage,
        model: this.model,
        tools: allToolCalls,
        toolResults: allToolResults,
        usage: latestUsage,
        latencyMs,
        latencyBreakdown,
        status: "ok"
      });

      await this.telemetry.captureModelBehavior({
        traceId,
        provider: this.provider.providerName,
        model: this.model,
        parameters: {
          temperature: this.temperature,
          top_p: this.topP,
          max_tokens: this.maxTokens
        },
        finishReason: latestFinishReason,
        safety: {
          reviewed_input: true,
          reviewed_output: true
        },
        toolDecisions: allToolCalls,
        toolResults: allToolResults,
        reasoningSummary: "Behavior data captured from runtime instrumentation.",
        usage: latestUsage,
        latencyMs,
        latencyBreakdown
      });

      const flush = await this.telemetry.flush();

      await this.logModelIo({
        phase: "turn_end",
        trace_id: traceId,
        output_text: finalAssistantText,
        latency_ms: latencyMs,
        usage: latestUsage,
        latency_breakdown: latencyBreakdown
      });

      return {
        traceId,
        outputText: finalAssistantText,
        usage: latestUsage,
        latencyMs,
        latencyBreakdown,
        flush
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const latencyBreakdown = createLatencyBreakdown({
        totalMs: latencyMs,
        modelMs: timing.modelMs,
        toolMs: timing.toolMs,
        modelCalls: timing.modelCalls,
        toolCalls: timing.toolCalls,
        toolFailures: timing.toolFailures,
        toolRounds: timing.toolRounds
      });

      await this.logModelIo({
        phase: "turn_error",
        trace_id: traceId,
        latency_ms: latencyMs,
        latency_breakdown: latencyBreakdown,
        error: {
          name: error.name,
          message: error.message
        }
      });

      await this.telemetry.captureModelBehavior({
        traceId,
        provider: this.provider.providerName,
        model: this.model,
        parameters: {
          temperature: this.temperature,
          top_p: this.topP,
          max_tokens: this.maxTokens
        },
        error: {
          name: error.name,
          message: error.message
        },
        latencyMs,
        latencyBreakdown
      });

      await this.telemetry.flush();
      throw error;
    }
  }
}
