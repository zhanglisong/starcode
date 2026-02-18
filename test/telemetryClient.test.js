import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TelemetryClient } from "../src/telemetry/telemetryClient.js";

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "starcode-telemetry-"));
}

function createClient({ spoolDir, endpoint = "http://127.0.0.1:8787", retryBaseMs = 100 } = {}) {
  return new TelemetryClient({
    endpoint,
    apiKey: "company-key",
    orgId: "acme",
    engineerId: "alice",
    teamId: "platform",
    projectId: "starcode",
    sessionId: "session-test",
    spoolDir,
    timeoutMs: 500,
    retryBaseMs,
    retryMaxMs: 1000,
    retryMultiplier: 2
  });
}

test("flush success updates sent metrics and clears queue", async () => {
  const dir = await makeTempDir();
  const client = createClient({ spoolDir: dir });
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 202,
      async text() {
        return "ok";
      }
    };
  };

  try {
    await client.captureSessionMeta({
      traceId: "trace-1",
      mode: "cli",
      git: { branch: "main" },
      machine: { hostname: "local" }
    });

    const result = await client.flush();
    assert.equal(result.flushed, 1);
    assert.equal(result.skipped, false);
    assert.equal(result.metrics.sent, 1);
    assert.equal(result.metrics.failed, 0);
    assert.equal(result.metrics.queued, 0);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("flush applies backoff after network failure", async () => {
  const dir = await makeTempDir();
  const client = createClient({ spoolDir: dir, retryBaseMs: 200 });
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("network down");
  };

  try {
    await client.captureSessionMeta({
      traceId: "trace-2",
      mode: "cli",
      git: { branch: "main" },
      machine: { hostname: "local" }
    });

    const first = await client.flush();
    assert.equal(first.flushed, 0);
    assert.equal(first.skipped, false);
    assert.equal(first.metrics.failed, 1);
    assert.equal(first.retry_after_ms >= 200, true);
    assert.equal(calls, 1);

    const second = await client.flush();
    assert.equal(second.skipped, true);
    assert.match(second.reason, /backoff/);
    assert.equal(calls, 1);

    client.nextRetryAt = Date.now() - 1;
    globalThis.fetch = async () => {
      calls += 1;
      return {
        ok: true,
        status: 202,
        async text() {
          return "ok";
        }
      };
    };

    const third = await client.flush();
    assert.equal(third.flushed, 1);
    assert.equal(third.metrics.queued, 0);
    assert.equal(third.metrics.sent, 1);
    assert.equal(third.metrics.failed, 1);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("non-2xx response keeps events queued and increments failure metrics", async () => {
  const dir = await makeTempDir();
  const client = createClient({ spoolDir: dir, retryBaseMs: 100 });
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    async text() {
      return "temporary outage";
    }
  });

  try {
    await client.captureSessionMeta({
      traceId: "trace-3",
      mode: "cli",
      git: { branch: "main" },
      machine: { hostname: "local" }
    });

    const failed = await client.flush();
    assert.equal(failed.flushed, 0);
    assert.equal(failed.metrics.failed, 1);
    assert.equal(failed.metrics.queued, 1);
    assert.match(failed.reason, /503/);

    client.nextRetryAt = Date.now() - 1;
    globalThis.fetch = async () => ({
      ok: true,
      status: 202,
      async text() {
        return "ok";
      }
    });

    const recovered = await client.flush();
    assert.equal(recovered.flushed, 1);
    assert.equal(recovered.metrics.queued, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
