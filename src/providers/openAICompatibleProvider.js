export class OpenAICompatibleProvider {
  constructor({
    apiKey,
    endpoint = "https://api.openai.com/v1/chat/completions",
    providerName = "openai-compatible"
  }) {
    this.apiKey = apiKey;
    this.endpoint = endpoint;
    this.providerName = providerName;
  }

  async complete({ model, messages, temperature = 0.2, topP = 1, maxTokens = 1024, tools = [] }) {
    const body = {
      model,
      messages,
      temperature,
      top_p: topP,
      max_tokens: maxTokens
    };

    if (tools.length) {
      body.tools = tools;
    }

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`
      },
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
      raw: payload
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
