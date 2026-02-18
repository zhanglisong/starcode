import { DEFAULT_ENDPOINTS, normalizeProviderName, resolveEndpoint } from "./openAICompatibleProvider.js";

function trimTrailingSlash(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

function toOpenAIModelsEndpoint(chatEndpoint) {
  const endpoint = trimTrailingSlash(chatEndpoint);
  if (!endpoint) {
    return "";
  }
  return endpoint.replace(/\/chat\/completions$/i, "/models");
}

function toOllamaTagsEndpoint(endpoint) {
  const normalized = trimTrailingSlash(endpoint);
  if (!normalized) {
    return "http://127.0.0.1:11434/api/tags";
  }
  return normalized
    .replace(/\/v1\/chat\/completions$/i, "/api/tags")
    .replace(/\/v1$/i, "/api/tags");
}

function withAbortTimeout(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return {
      signal: undefined,
      cancel: () => {}
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer)
  };
}

export async function listProviderModels({
  providerName,
  endpoint = "",
  apiKey = "",
  fetchImpl = fetch,
  timeoutMs = 8000
}) {
  const provider = normalizeProviderName(providerName);
  const resolvedEndpoint = resolveEndpoint(provider, endpoint);
  const { signal, cancel } = withAbortTimeout(timeoutMs);

  try {
    if (provider === "ollama") {
      const modelEndpoint = toOllamaTagsEndpoint(resolvedEndpoint);
      const response = await fetchImpl(modelEndpoint, {
        method: "GET",
        signal
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`model catalog ${response.status}: ${detail}`);
      }

      const payload = await response.json();
      const models = Array.isArray(payload?.models)
        ? payload.models
            .map((item) => String(item?.name ?? "").trim())
            .filter(Boolean)
            .sort()
        : [];

      return {
        provider,
        endpoint: modelEndpoint,
        models
      };
    }

    const modelEndpoint = toOpenAIModelsEndpoint(resolvedEndpoint);
    const headers = {};
    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
    }

    const response = await fetchImpl(modelEndpoint, {
      method: "GET",
      headers,
      signal
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`model catalog ${response.status}: ${detail}`);
    }

    const payload = await response.json();
    const models = Array.isArray(payload?.data)
      ? payload.data
          .map((item) => String(item?.id ?? "").trim())
          .filter(Boolean)
          .sort()
      : [];

    return {
      provider,
      endpoint: modelEndpoint || DEFAULT_ENDPOINTS[provider],
      models
    };
  } finally {
    cancel();
  }
}
