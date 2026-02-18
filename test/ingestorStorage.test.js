import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { IngestStorage } from "../src/ingestor/storage.js";

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "starcode-ingestor-"));
}

function makeEvent({
  eventId,
  org = "acme",
  team = "platform",
  engineer = "alice",
  type = "conversation.turn",
  occurredAt = "2026-02-18T00:00:00.000Z"
}) {
  return {
    event_id: eventId,
    schema_version: 1,
    event_type: type,
    occurred_at: occurredAt,
    org_id: org,
    engineer_id: engineer,
    team_id: team,
    project_id: "starcode",
    session_id: "session-1",
    trace_id: `trace-${eventId}`,
    payload: { ok: true }
  };
}

test("writeEvents deduplicates repeated event_id within and across writes", async () => {
  const dir = await makeTempDir();
  const storage = new IngestStorage(dir);

  const batch = [
    makeEvent({ eventId: "evt-1" }),
    makeEvent({ eventId: "evt-1" }),
    makeEvent({ eventId: "evt-2" })
  ];

  const first = await storage.writeEvents(batch);
  assert.deepEqual(first, { accepted: 2, deduplicated: 1 });

  const second = await storage.writeEvents(batch);
  assert.deepEqual(second, { accepted: 0, deduplicated: 3 });

  const total = await storage.countAllEvents();
  assert.equal(total, 2);
});

test("dedupe survives storage re-initialization", async () => {
  const dir = await makeTempDir();
  const firstStorage = new IngestStorage(dir);

  await firstStorage.writeEvents([makeEvent({ eventId: "evt-restart-1" })]);

  const secondStorage = new IngestStorage(dir);
  const result = await secondStorage.writeEvents([
    makeEvent({ eventId: "evt-restart-1" }),
    makeEvent({ eventId: "evt-restart-2" })
  ]);

  assert.deepEqual(result, { accepted: 1, deduplicated: 1 });

  const total = await secondStorage.countAllEvents();
  assert.equal(total, 2);
});

test("summarizeMetadata reports org/team/engineer aggregation", async () => {
  const dir = await makeTempDir();
  const storage = new IngestStorage(dir);

  await storage.writeEvents([
    makeEvent({ eventId: "evt-a", org: "acme", team: "platform", engineer: "alice" }),
    makeEvent({ eventId: "evt-b", org: "acme", team: "platform", engineer: "bob" }),
    makeEvent({ eventId: "evt-c", org: "acme", team: "infra", engineer: "bob" }),
    makeEvent({ eventId: "evt-d", org: "beta", team: "platform", engineer: "carol" })
  ]);

  const summary = await storage.summarizeMetadata();

  assert.equal(summary.orgs, 2);
  assert.equal(summary.teams, 2);
  assert.equal(summary.engineers, 3);
  assert.deepEqual(summary.by_org, [
    { id: "acme", events: 3 },
    { id: "beta", events: 1 }
  ]);
});

test("writeEvents stores redacted payload content", async () => {
  const dir = await makeTempDir();
  const storage = new IngestStorage(dir);

  const occurredAt = "2026-02-18T00:00:00.000Z";
  await storage.writeEvents([
    {
      ...makeEvent({ eventId: "evt-redact", occurredAt }),
      payload: {
        request: { content: "email me at alice@example.com" },
        response: { content: "token sk-1234567890abcdefghijkl" }
      }
    }
  ]);

  const day = occurredAt.slice(0, 10);
  const filePath = path.join(dir, "acme", day, "conversation.turn.jsonl");
  const raw = await fs.readFile(filePath, "utf8");

  assert.equal(raw.includes("alice@example.com"), false);
  assert.equal(raw.includes("sk-1234567890abcdefghijkl"), false);
  assert.equal(raw.includes("[REDACTED_EMAIL]"), true);
  assert.equal(raw.includes("[REDACTED_API_KEY]"), true);
});

test("deleteEvents removes rows by engineer and writes audit log", async () => {
  const dir = await makeTempDir();
  const storage = new IngestStorage(dir);

  await storage.writeEvents([
    makeEvent({ eventId: "evt-del-1", engineer: "alice" }),
    makeEvent({ eventId: "evt-del-2", engineer: "bob" }),
    makeEvent({ eventId: "evt-del-3", engineer: "alice" })
  ]);

  const result = await storage.deleteEvents({
    orgId: "acme",
    engineerId: "alice",
    actor: "security-admin"
  });

  assert.deepEqual(result, {
    deleted_events: 2,
    files_touched: 1
  });

  const total = await storage.countAllEvents();
  assert.equal(total, 1);

  const auditRaw = await fs.readFile(path.join(dir, "_audit", "audit.jsonl"), "utf8");
  assert.match(auditRaw, /events.delete/);
  assert.match(auditRaw, /security-admin/);
});

test("applyRetention removes out-of-policy rows", async () => {
  const dir = await makeTempDir();
  const storage = new IngestStorage(dir);

  const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  const freshDate = new Date().toISOString();

  await storage.writeEvents([
    makeEvent({ eventId: "evt-ret-1", occurredAt: oldDate }),
    makeEvent({ eventId: "evt-ret-2", occurredAt: freshDate })
  ]);

  const result = await storage.applyRetention(30, { actor: "retention-job" });
  assert.equal(result.deleted_events, 1);
  assert.equal(result.retention_days, 30);

  const total = await storage.countAllEvents();
  assert.equal(total, 1);

  const auditRaw = await fs.readFile(path.join(dir, "_audit", "audit.jsonl"), "utf8");
  assert.match(auditRaw, /events.retention/);
  assert.match(auditRaw, /retention-job/);
});
