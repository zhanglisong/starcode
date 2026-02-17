import test from "node:test";
import assert from "node:assert/strict";
import { buildSftRecord, buildBehaviorRecord } from "../src/training/builders.js";

const base = {
  event_id: "id-1",
  event_type: "conversation.turn",
  occurred_at: "2026-02-16T00:00:00.000Z",
  org_id: "acme",
  engineer_id: "alice",
  project_id: "starcode",
  session_id: "session-1",
  trace_id: "trace-1",
  payload: {
    request: { role: "user", content: "Write tests" },
    response: { role: "assistant", content: "Here are tests." },
    model: "gpt-4.1-mini",
    latency_ms: 100,
    usage: { total_tokens: 10 }
  }
};

test("buildSftRecord maps conversation event", () => {
  const row = buildSftRecord(base);
  assert.equal(row.messages[0].role, "user");
  assert.equal(row.messages[1].role, "assistant");
  assert.equal(row.org_id, "acme");
});

test("buildBehaviorRecord maps model behavior", () => {
  const row = buildBehaviorRecord({
    ...base,
    event_type: "model.behavior",
    payload: {
      provider: "mock",
      model: "m1",
      parameters: { temperature: 0.2 },
      finish_reason: "stop",
      tool_results: [{ name: "write_file", ok: true }],
      usage: { total_tokens: 8 },
      latency_ms: 90
    }
  });

  assert.equal(row.label, "model.behavior");
  assert.equal(row.provider, "mock");
  assert.equal(row.model, "m1");
  assert.equal(Array.isArray(row.tool_results), true);
  assert.equal(row.tool_results.length, 1);
});
