import test from "node:test";
import assert from "node:assert/strict";
import { listProviderModels } from "../src/providers/modelCatalog.js";

function okJson(payload, contentType = "application/json") {
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "content-type" ? contentType : "";
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

test("listProviderModels reads OpenAI-compatible /models format", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return okJson({
      data: [{ id: "gpt-4.1-mini" }, { id: "gpt-4.1" }]
    });
  };

  const result = await listProviderModels({
    providerName: "openai-compatible",
    endpoint: "https://example.com/v1/chat/completions",
    apiKey: "sk-test",
    fetchImpl
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.com/v1/models");
  assert.equal(calls[0].options.headers.authorization, "Bearer sk-test");
  assert.deepEqual(result.models, ["gpt-4.1", "gpt-4.1-mini"]);
});

test("listProviderModels reads Ollama /api/tags format", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return okJson({
      models: [{ name: "qwen2.5-coder:7b" }, { name: "llama3.1:8b" }]
    });
  };

  const result = await listProviderModels({
    providerName: "ollama",
    endpoint: "http://127.0.0.1:11434/v1/chat/completions",
    fetchImpl
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:11434/api/tags");
  assert.deepEqual(result.models, ["llama3.1:8b", "qwen2.5-coder:7b"]);
});
