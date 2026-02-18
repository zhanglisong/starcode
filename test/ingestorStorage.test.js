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
