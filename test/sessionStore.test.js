import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../src/session/store.js";

async function makeStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "starcode-session-store-"));
  return new SessionStore({ baseDir: dir });
}

test("session store create/append/list/delete lifecycle", async () => {
  const store = await makeStore();
  const created = await store.create({
    id: "session-a",
    workspaceDir: "/tmp/work"
  });

  assert.equal(created.id, "session-a");
  assert.equal(created.parent_session_id, null);

  await store.appendTurn({
    id: "session-a",
    traceId: "trace-1",
    inputText: "hello",
    outputText: "world",
    usage: { total_tokens: 10 },
    latencyMs: 50,
    status: "ok",
    toolCalls: [],
    toolResults: [],
    messages: [{ role: "system", content: "s" }, { role: "user", content: "hello" }],
    sessionSummary: "summary"
  });

  const loaded = await store.load("session-a");
  assert.equal(loaded.turns.length, 1);
  assert.equal(loaded.messages.length, 2);
  assert.equal(loaded.session_summary, "summary");

  const list = await store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "session-a");

  await store.delete("session-a");
  const deleted = await store.load("session-a");
  assert.equal(deleted, null);
});

test("session store fork preserves parent_session_id", async () => {
  const store = await makeStore();
  await store.create({ id: "parent" });
  await store.appendTurn({
    id: "parent",
    traceId: "trace-1",
    inputText: "one",
    outputText: "two",
    usage: {},
    latencyMs: 0,
    status: "ok",
    toolCalls: [],
    toolResults: [],
    messages: [{ role: "system", content: "base" }, { role: "assistant", content: "done" }],
    sessionSummary: "memory"
  });

  const forked = await store.fork("parent", { id: "child" });
  assert.equal(forked.id, "child");
  assert.equal(forked.parent_session_id, "parent");
  assert.equal(forked.messages.length, 2);
  assert.equal(forked.turns.length, 1);
});
