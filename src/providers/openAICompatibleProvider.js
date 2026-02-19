export const DEFAULT_ENDPOINTS = {
  "openai-compatible": "https://api.openai.com/v1/chat/completions",
  openai: "https://api.openai.com/v1/chat/completions",
  moonshot: "https://api.moonshot.ai/v1/chat/completions",
  ollama: "http://127.0.0.1:11434/v1/chat/completions"
};

export function normalizeProviderName(providerName) {
  const normalized = String(providerName ?? "openai-compatible").toLowerCase();

  if (normalized in DEFAULT_ENDPOINTS) {
    return normalized;
  }

  return "openai-compatible";
}

export function resolveEndpoint(providerName, endpoint) {
  if (endpoint && typeof endpoint === "string") {
    return endpoint;
  }

  return DEFAULT_ENDPOINTS[providerName] ?? DEFAULT_ENDPOINTS["openai-compatible"];
}

function shouldSendAuthorization(providerName) {
  return providerName !== "ollama";
}

function estimateTokenCount(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const chars = text?.length ?? 0;
  return Math.max(1, Math.ceil(chars / 4));
}

function hasUsageTokens(usage) {
  if (!usage || typeof usage !== "object") {
    return false;
  }
  return Number.isFinite(Number(usage.total_tokens)) || Number.isFinite(Number(usage.prompt_tokens));
}

function normalizeUsage(usage, { messages = [], tools = [], outputText = "" } = {}) {
  if (hasUsageTokens(usage)) {
    const prompt = Number(usage.prompt_tokens ?? 0);
    const completion = Number(usage.completion_tokens ?? 0);
    const total = Number(usage.total_tokens ?? prompt + completion);
    return {
      ...usage,
      prompt_tokens: Number.isFinite(prompt) ? prompt : 0,
      completion_tokens: Number.isFinite(completion) ? completion : 0,
      total_tokens: Number.isFinite(total) ? total : 0,
      estimated: usage?.estimated === true
    };
  }

  const promptTokens = estimateTokenCount({
    messages,
    tools
  });
  const completionTokens = estimateTokenCount(outputText || "");

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    estimated: true
  };
}

function buildResultFromPayload(payload, providerMeta, requestMeta = {}) {
  const choice = payload?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const outputText = msg.content ?? "";

  return {
    outputText,
    finishReason: choice.finish_reason ?? "unknown",
    toolCalls: msg.tool_calls ?? [],
    message: msg,
    usage: normalizeUsage(payload?.usage, {
      messages: requestMeta.messages,
      tools: requestMeta.tools,
      outputText
    }),
    raw: payload,
    providerMeta
  };
}

function applyProviderConstraints({ providerName, model, temperature, topP, maxTokens }) {
  const effective = {
    temperature,
    topP,
    maxTokens,
    constraints: []
  };

  if (providerName === "moonshot" && /^kimi-k2\.5$/i.test(String(model ?? ""))) {
    if (effective.temperature !== 1) {
      effective.temperature = 1;
      effective.constraints.push({ field: "temperature", value: 1, reason: "moonshot-kimi-k2.5-fixed" });
    }

    if (effective.topP !== 0.95) {
      effective.topP = 0.95;
      effective.constraints.push({ field: "top_p", value: 0.95, reason: "moonshot-kimi-k2.5-fixed" });
    }
  }

  return effective;
}

export class OpenAICompatibleProvider {
  constructor({ apiKey, endpoint, providerName = "openai-compatible" }) {
    this.providerName = normalizeProviderName(providerName);
    this.apiKey = apiKey ?? "";
    this.endpoint = resolveEndpoint(this.providerName, endpoint);
    this.sendAuthorization = shouldSendAuthorization(this.providerName);
  }

  async complete({
    model,
    messages,
    temperature = 0.2,
    topP = 1,
    maxTokens = 1024,
    tools = [],
    stream = false,
    onDelta
  }) {
    if (stream) {
      return this.completeStream({
        model,
        messages,
        temperature,
        topP,
        maxTokens,
        tools,
        onDelta
      });
    }

    const effective = applyProviderConstraints({
      providerName: this.providerName,
      model,
      temperature,
      topP,
      maxTokens
    });

    const body = {
      model,
      messages,
      max_tokens: effective.maxTokens
    };

    if (Number.isFinite(effective.temperature)) {
      body.temperature = effective.temperature;
    }

    if (Number.isFinite(effective.topP)) {
      body.top_p = effective.topP;
    }

    if (tools.length) {
      body.tools = tools;
    }

    const headers = {
      "content-type": "application/json"
    };

    if (this.sendAuthorization && this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`provider response ${response.status}: ${detail}`);
    }

    const payload = await response.json();
    return buildResultFromPayload(
      payload,
      {
        provider: this.providerName,
        endpoint: this.endpoint,
        constraints: effective.constraints
      },
      {
        messages,
        tools
      }
    );
  }

  async completeStream({ model, messages, temperature = 0.2, topP = 1, maxTokens = 1024, tools = [], onDelta }) {
    const effective = applyProviderConstraints({
      providerName: this.providerName,
      model,
      temperature,
      topP,
      maxTokens
    });

    const body = {
      model,
      messages,
      stream: true,
      max_tokens: effective.maxTokens
    };

    if (Number.isFinite(effective.temperature)) {
      body.temperature = effective.temperature;
    }

    if (Number.isFinite(effective.topP)) {
      body.top_p = effective.topP;
    }

    if (tools.length) {
      body.tools = tools;
    }

    const headers = {
      "content-type": "application/json"
    };

    if (this.sendAuthorization && this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`provider response ${response.status}: ${detail}`);
    }

    const contentType = String(response.headers?.get?.("content-type") ?? "").toLowerCase();
    if (!contentType.includes("text/event-stream")) {
      const error = new Error(`stream unsupported: expected event-stream but got '${contentType || "unknown"}'`);
      error.streamUnsupported = true;
      throw error;
    }

    const reader = response.body?.getReader?.();
    if (!reader) {
      const error = new Error("stream unsupported: response body reader unavailable");
      error.streamUnsupported = true;
      throw error;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let finishReason = "unknown";
    let usage = {};
    let content = "";
    let reasoningContent = "";
    const toolCallsByIndex = new Map();

    const mergeToolCall = (fragment) => {
      const index = Number.isInteger(fragment?.index) ? fragment.index : 0;
      const current = toolCallsByIndex.get(index) ?? {
        id: fragment?.id ?? `call_${index}`,
        type: fragment?.type ?? "function",
        function: {
          name: "",
          arguments: ""
        }
      };

      if (fragment?.id) {
        current.id = fragment.id;
      }
      if (fragment?.type) {
        current.type = fragment.type;
      }
      if (typeof fragment?.function?.name === "string") {
        current.function.name += fragment.function.name;
      }
      if (typeof fragment?.function?.arguments === "string") {
        current.function.arguments += fragment.function.arguments;
      }

      toolCallsByIndex.set(index, current);
    };

    const emitDelta = (delta) => {
      if (typeof onDelta === "function") {
        onDelta(delta);
      }
    };

    const consumeLine = (line) => {
      const trimmed = String(line ?? "").trim();
      if (!trimmed.startsWith("data:")) {
        return false;
      }

      const data = trimmed.slice("data:".length).trim();
      if (!data) {
        return false;
      }
      if (data === "[DONE]") {
        return true;
      }

      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        return false;
      }

      const choice = payload?.choices?.[0] ?? {};
      const delta = choice?.delta ?? {};

      if (typeof delta.content === "string" && delta.content) {
        content += delta.content;
        emitDelta({ type: "text", text: delta.content });
      }
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        reasoningContent += delta.reasoning_content;
        emitDelta({ type: "reasoning", text: delta.reasoning_content });
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const fragment of delta.tool_calls) {
          mergeToolCall(fragment);
          emitDelta({
            type: "tool_call_delta",
            tool_call_index: Number.isInteger(fragment?.index) ? fragment.index : 0,
            fragment
          });
        }
      }

      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;
      }
      if (payload?.usage) {
        usage = payload.usage;
      }

      return false;
    };

    let streamDone = false;
    while (!streamDone) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (consumeLine(line)) {
          streamDone = true;
          break;
        }
      }
    }

    if (buffer) {
      consumeLine(buffer);
    }

    const toolCalls = [...toolCallsByIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map((entry) => entry[1]);

    const message = {
      role: "assistant",
      content
    };

    if (reasoningContent) {
      message.reasoning_content = reasoningContent;
    }
    if (toolCalls.length) {
      message.tool_calls = toolCalls;
    }

    const normalizedUsage = normalizeUsage(usage, {
      messages,
      tools,
      outputText: content
    });

    return {
      outputText: content,
      finishReason,
      toolCalls,
      message,
      usage: normalizedUsage,
      raw: {
        streaming: true
      },
      providerMeta: {
        provider: this.providerName,
        endpoint: this.endpoint,
        constraints: effective.constraints
      }
    };
  }
}

export class MockProvider {
  constructor() {
    this.providerName = "mock";
  }

  async complete({ messages }) {
    const prompt = messages[messages.length - 1]?.content ?? "";
    return {
      outputText: `Mock answer: ${prompt}`,
      finishReason: "stop",
      toolCalls: [],
      message: {
        role: "assistant",
        content: `Mock answer: ${prompt}`
      },
      usage: {
        prompt_tokens: Math.ceil(prompt.length / 4),
        completion_tokens: 12,
        total_tokens: Math.ceil(prompt.length / 4) + 12
      },
      raw: {}
    };
  }
}
