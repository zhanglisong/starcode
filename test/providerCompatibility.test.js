import test from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleProvider } from "../src/providers/openAICompatibleProvider.js";

function okResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: {
      get() {
        return "application/json";
      }
    },
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    }
  };
}

function streamResponse(chunks) {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index]));
      index += 1;
    }
  });

  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        if (String(name).toLowerCase() === "content-type") {
          return "text/event-stream";
        }
        return null;
      }
    },
    body,
    async json() {
      throw new Error("stream response does not support json()");
    },
    async text() {
      return chunks.join("");
    }
  };
}

function errResponse(status, body) {
  return {
    ok: false,
    status,
    async json() {
      return { error: body };
    },
    async text() {
      return body;
    }
  };
}

test("moonshot kimi-k2.5 applies fixed temperature and top_p", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return okResponse({
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "ok"
          }
        }
      ],
      usage: { total_tokens: 12 }
    });
  };

  try {
    const provider = new OpenAICompatibleProvider({
      apiKey: "sk-test",
      providerName: "moonshot"
    });

    await provider.complete({
      model: "kimi-k2.5",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.2,
      topP: 1,
      maxTokens: 777
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.moonshot.ai/v1/chat/completions");

    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.temperature, 1);
    assert.equal(body.top_p, 0.95);
    assert.equal(body.max_tokens, 777);
    assert.equal(calls[0].options.headers.authorization, "Bearer sk-test");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ollama default endpoint does not require authorization header", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return okResponse({
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "ok"
          }
        }
      ]
    });
  };

  try {
    const provider = new OpenAICompatibleProvider({
      providerName: "ollama"
    });

    await provider.complete({
      model: "qwen2.5-coder:7b",
      messages: [{ role: "user", content: "hi" }]
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://127.0.0.1:11434/v1/chat/completions");
    assert.equal(Object.prototype.hasOwnProperty.call(calls[0].options.headers, "authorization"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai-compatible forwards sampling parameters and tools", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return okResponse({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: "{}"
                }
              }
            ]
          }
        }
      ]
    });
  };

  try {
    const provider = new OpenAICompatibleProvider({
      apiKey: "sk-openai-like",
      providerName: "openai-compatible",
      endpoint: "https://example.com/v1/chat/completions"
    });

    const result = await provider.complete({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.3,
      topP: 0.8,
      maxTokens: 222,
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            parameters: { type: "object", properties: {} }
          }
        }
      ]
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://example.com/v1/chat/completions");

    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.temperature, 0.3);
    assert.equal(body.top_p, 0.8);
    assert.equal(body.max_tokens, 222);
    assert.equal(Array.isArray(body.tools), true);
    assert.equal(body.tools.length, 1);

    assert.equal(result.finishReason, "tool_calls");
    assert.equal(Array.isArray(result.toolCalls), true);
    assert.equal(result.toolCalls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider surfaces non-2xx responses with details", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => errResponse(401, "incorrect api key");

  try {
    const provider = new OpenAICompatibleProvider({
      apiKey: "bad",
      providerName: "moonshot"
    });

    await assert.rejects(
      () =>
        provider.complete({
          model: "kimi-k2.5",
          messages: [{ role: "user", content: "hi" }]
        }),
      (error) => {
        assert.equal(error instanceof Error, true);
        assert.match(error.message, /provider response 401/);
        assert.match(error.message, /incorrect api key/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider estimates usage when response omits usage payload", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    okResponse({
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "hello"
          }
        }
      ]
    });

  try {
    const provider = new OpenAICompatibleProvider({
      apiKey: "sk-test",
      providerName: "moonshot"
    });

    const result = await provider.complete({
      model: "kimi-k2.5",
      messages: [{ role: "user", content: "say hello" }]
    });

    assert.equal(result.usage.estimated, true);
    assert.equal(Number.isFinite(result.usage.prompt_tokens), true);
    assert.equal(Number.isFinite(result.usage.completion_tokens), true);
    assert.equal(result.usage.total_tokens > 0, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai-compatible parses streaming deltas and tool call fragments", async () => {
  const originalFetch = globalThis.fetch;
  const deltas = [];

  globalThis.fetch = async () =>
    streamResponse([
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n',
      'data: {"choices":[{"delta":{"content":"Hello "}}]}\n',
      'data: {"choices":[{"delta":{"content":"world"}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\""}}]}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"README.md\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"total_tokens":33}}\n',
      "data: [DONE]\n"
    ]);

  try {
    const provider = new OpenAICompatibleProvider({
      apiKey: "sk-stream",
      providerName: "openai-compatible",
      endpoint: "https://example.com/v1/chat/completions"
    });

    const result = await provider.complete({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      onDelta: (delta) => deltas.push(delta)
    });

    assert.equal(result.outputText, "Hello world");
    assert.equal(result.finishReason, "tool_calls");
    assert.equal(result.usage.total_tokens, 33);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].function.name, "read_file");
    assert.equal(result.toolCalls[0].function.arguments, '{"path":"README.md"}');
    assert.deepEqual(
      deltas.filter((delta) => delta.type === "text").map((delta) => delta.text),
      ["Hello ", "world"]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streaming provider estimates usage when stream omits usage payload", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    streamResponse([
      'data: {"choices":[{"delta":{"content":"tokenless stream"}}]}\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n',
      "data: [DONE]\n"
    ]);

  try {
    const provider = new OpenAICompatibleProvider({
      apiKey: "sk-stream",
      providerName: "openai-compatible"
    });

    const result = await provider.complete({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: "hello there" }],
      stream: true
    });

    assert.equal(result.usage.estimated, true);
    assert.equal(result.usage.total_tokens > 0, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stream mode marks mismatch as streamUnsupported", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    okResponse({
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "ok"
          }
        }
      ]
    });

  try {
    const provider = new OpenAICompatibleProvider({
      apiKey: "sk-stream",
      providerName: "openai-compatible"
    });

    await assert.rejects(
      () =>
        provider.complete({
          model: "gpt-4.1-mini",
          messages: [{ role: "user", content: "hi" }],
          stream: true
        }),
      (error) => {
        assert.equal(error instanceof Error, true);
        assert.equal(error.streamUnsupported, true);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
