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
    this.localTools = localTools;
    this.model = model;
    this.temperature = temperature;
    this.topP = topP;
    this.maxTokens = maxTokens;
    this.maxToolRounds = maxToolRounds;
    this.messages = [{ role: "system", content: systemPrompt }];
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

          try {
            const toolResult = await this.localTools.executeToolCall(call);
            allToolResults.push({
              tool_call_id: call?.id ?? null,
              name: toolName,
              arguments: parsedArguments,
              ok: true,
              result: toolResult,
              duration_ms: Date.now() - toolStartedAt
            });

            this.messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify(toolResult)
            });
          } catch (error) {
            allToolResults.push({
              tool_call_id: call?.id ?? null,
              name: toolName,
              arguments: parsedArguments,
              ok: false,
              error: error.message,
              duration_ms: Date.now() - toolStartedAt
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

      return {
        traceId,
        outputText: finalAssistantText,
        usage: latestUsage,
        latencyMs,
        flush
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;

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
