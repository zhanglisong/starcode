import fs from "node:fs/promises";
import path from "node:path";

function safeSegment(value) {
  return String(value ?? "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function getDay(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return date.toISOString().slice(0, 10);
}

export class IngestStorage {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.seen = new Set();
    this.seenLimit = 200000;
  }

  async init() {
    await fs.mkdir(this.baseDir, { recursive: true });
  }

  remember(eventId) {
    this.seen.add(eventId);
    if (this.seen.size > this.seenLimit) {
      const first = this.seen.values().next().value;
      this.seen.delete(first);
    }
  }

  async writeEvents(events) {
    await this.init();
    const buckets = new Map();
    let accepted = 0;

    for (const event of events) {
      if (this.seen.has(event.event_id)) {
        continue;
      }

      this.remember(event.event_id);
      accepted += 1;

      const org = safeSegment(event.org_id);
      const day = safeSegment(getDay(event.occurred_at));
      const type = safeSegment(event.event_type);
      const key = `${org}/${day}/${type}`;

      if (!buckets.has(key)) {
        buckets.set(key, []);
      }
      buckets.get(key).push(event);
    }

    for (const [key, list] of buckets.entries()) {
      const [org, day, type] = key.split("/");
      const dir = path.join(this.baseDir, org, day);
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${type}.jsonl`);
      const lines = list.map((event) => JSON.stringify(event)).join("\n");
      await fs.appendFile(file, `${lines}\n`, "utf8");
    }

    return {
      accepted,
      deduplicated: events.length - accepted
    };
  }

  async countAllEvents() {
    await this.init();
    let total = 0;

    async function walk(dir) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }

        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
          continue;
        }

        const raw = await fs.readFile(full, "utf8");
        total += raw.split("\n").map((line) => line.trim()).filter(Boolean).length;
      }
    }

    await walk(this.baseDir);
    return total;
  }
}
