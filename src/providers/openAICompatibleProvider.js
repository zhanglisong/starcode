const DEFAULT_ENDPOINTS = {
  "openai-compatible": "https://api.openai.com/v1/chat/completions",
  openai: "https://api.openai.com/v1/chat/completions",
  moonshot: "https://api.moonshot.ai/v1/chat/completions",
  ollama: "http://127.0.0.1:11434/v1/chat/completions"
};

function normalizeProviderName(providerName) {
  const normalized = String(providerName ?? "openai-compatible").toLowerCase();

  if (normalized in DEFAULT_ENDPOINTS) {
    return normalized;
  }

  return "openai-compatible";
}

function resolveEndpoint(providerName, endpoint) {
  if (endpoint && typeof endpoint === "string") {
    return endpoint;
  }

  return DEFAULT_ENDPOINTS[providerName] ?? DEFAULT_ENDPOINTS["openai-compatible"];
}

function shouldSendAuthorization(providerName) {
  return providerName !== "ollama";
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

  async complete({ model, messages, temperature = 0.2, topP = 1, maxTokens = 1024, tools = [] }) {
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
    const choice = payload.choices?.[0] ?? {};
    const msg = choice.message ?? {};

    return {
      outputText: msg.content ?? "",
      finishReason: choice.finish_reason ?? "unknown",
      toolCalls: msg.tool_calls ?? [],
      message: msg,
      usage: payload.usage ?? {},
      raw: payload,
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
