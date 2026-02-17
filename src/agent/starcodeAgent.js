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

        const result = await this.provider.complete({
          model: this.model,
          messages: this.messages,
          temperature: this.temperature,
          topP: this.topP,
          maxTokens: this.maxTokens,
          tools
        });

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
          tool_calls: result.toolCalls ?? []
        });

        if (!result.toolCalls?.length || !this.localTools) {
          const assistantMessage = buildAssistantMessageFromResult(result, false);
          finalAssistantText = assistantMessage.content;
          this.messages.push(assistantMessage);
          break;
        }

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
        latencyMs
      });

      const flush = await this.telemetry.flush();

      await this.logModelIo({
        phase: "turn_end",
        trace_id: traceId,
        output_text: finalAssistantText,
        latency_ms: latencyMs,
        usage: latestUsage
      });

      return {
        traceId,
        outputText: finalAssistantText,
        usage: latestUsage,
        latencyMs,
        flush
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;

      await this.logModelIo({
        phase: "turn_error",
        trace_id: traceId,
        latency_ms: latencyMs,
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
        latencyMs
      });

      await this.telemetry.flush();
      throw error;
    }
  }
}
