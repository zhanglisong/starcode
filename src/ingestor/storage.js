import fs from "node:fs/promises";
import path from "node:path";
import { redactSensitiveData } from "../telemetry/redaction.js";

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

function increment(map, key) {
  const normalized = String(key ?? "unknown");
  map.set(normalized, (map.get(normalized) ?? 0) + 1);
}

function mapToSortedArray(map) {
  return [...map.entries()]
    .map(([id, events]) => ({ id, events }))
    .sort((a, b) => b.events - a.events || a.id.localeCompare(b.id));
}

function parseJsonLines(text) {
  return String(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function withinRetention(occurredAt, retentionDays) {
  const ts = Date.parse(occurredAt);
  if (!Number.isFinite(ts)) {
    return true;
  }

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  return ts >= cutoff;
}

function matchesDeleteFilter(event, { orgId, engineerId, traceId }) {
  if (orgId && event.org_id !== orgId) {
    return false;
  }
  if (engineerId && event.engineer_id !== engineerId) {
    return false;
  }
  if (traceId && event.trace_id !== traceId) {
    return false;
  }

  return true;
}

export class IngestStorage {
  constructor(baseDir, { enableAudit = true } = {}) {
    this.baseDir = baseDir;
    this.seen = new Set();
    this.seenLimit = 200000;
    this.seenIndexFile = path.join(this.baseDir, ".seen_event_ids.jsonl");
    this.auditDir = path.join(this.baseDir, "_audit");
    this.auditFile = path.join(this.auditDir, "audit.jsonl");
    this.enableAudit = !!enableAudit;
    this.initialized = false;
  }

  async init() {
    if (this.initialized) {
      return;
    }

    await fs.mkdir(this.baseDir, { recursive: true });

    try {
      const raw = await fs.readFile(this.seenIndexFile, "utf8");
      for (const line of raw.split("\n")) {
        const id = line.trim();
        if (!id) {
          continue;
        }
        this.remember(id);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    this.initialized = true;
  }

  remember(eventId) {
    this.seen.add(eventId);
    if (this.seen.size > this.seenLimit) {
      const first = this.seen.values().next().value;
      this.seen.delete(first);
    }
  }

  async appendSeenIndex(eventIds) {
    if (!eventIds.length) {
      return;
    }

    const lines = eventIds.map((id) => String(id).trim()).filter(Boolean);
    if (!lines.length) {
      return;
    }

    await fs.appendFile(this.seenIndexFile, `${lines.join("\n")}\n`, "utf8");
  }

  async rewriteSeenIndex() {
    const lines = [...this.seen.values()].filter(Boolean);
    await fs.writeFile(this.seenIndexFile, lines.length ? `${lines.join("\n")}\n` : "", "utf8");
  }

  isDataFile(fullPath, fileName) {
    if (!fileName.endsWith(".jsonl")) {
      return false;
    }

    return fullPath !== this.seenIndexFile && fullPath !== this.auditFile;
  }

  async listEventFiles() {
    await this.init();
    const output = [];

    const walk = async (dir) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }

        if (!entry.isFile() || !this.isDataFile(full, entry.name)) {
          continue;
        }

        output.push(full);
      }
    };

    await walk(this.baseDir);
    return output;
  }

  async writeAuditEntry({ action, actor = "system", details = {} }) {
    if (!this.enableAudit) {
      return;
    }

    await fs.mkdir(this.auditDir, { recursive: true });
    const row = {
      occurred_at: new Date().toISOString(),
      action,
      actor,
      details
    };

    await fs.appendFile(this.auditFile, `${JSON.stringify(row)}\n`, "utf8");
  }

  async writeEvents(events) {
    await this.init();
    const buckets = new Map();
    const acceptedIds = [];

    for (const event of events) {
      const sanitizedEvent = redactSensitiveData(event);

      if (this.seen.has(sanitizedEvent.event_id)) {
        continue;
      }

      this.remember(sanitizedEvent.event_id);
      acceptedIds.push(sanitizedEvent.event_id);

      const org = safeSegment(sanitizedEvent.org_id);
      const day = safeSegment(getDay(sanitizedEvent.occurred_at));
      const type = safeSegment(sanitizedEvent.event_type);
      const key = `${org}/${day}/${type}`;

      if (!buckets.has(key)) {
        buckets.set(key, []);
      }
      buckets.get(key).push(sanitizedEvent);
    }

    for (const [key, list] of buckets.entries()) {
      const [org, day, type] = key.split("/");
      const dir = path.join(this.baseDir, org, day);
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${type}.jsonl`);
      const lines = list.map((event) => JSON.stringify(event)).join("\n");
      await fs.appendFile(file, `${lines}\n`, "utf8");
    }

    await this.appendSeenIndex(acceptedIds);

    const result = {
      accepted: acceptedIds.length,
      deduplicated: events.length - acceptedIds.length
    };

    await this.writeAuditEntry({
      action: "events.write",
      details: result
    });

    return result;
  }

  async deleteEvents({ orgId, engineerId, traceId, actor = "admin" } = {}) {
    if (!orgId && !engineerId && !traceId) {
      throw new Error("at least one filter is required: orgId, engineerId, or traceId");
    }

    const files = await this.listEventFiles();
    let deletedEvents = 0;
    let filesTouched = 0;
    const deletedIds = [];

    for (const file of files) {
      const rows = parseJsonLines(await fs.readFile(file, "utf8"));
      const keep = [];
      let touched = false;

      for (const row of rows) {
        if (matchesDeleteFilter(row, { orgId, engineerId, traceId })) {
          touched = true;
          deletedEvents += 1;
          if (row.event_id) {
            deletedIds.push(row.event_id);
          }
        } else {
          keep.push(row);
        }
      }

      if (!touched) {
        continue;
      }

      filesTouched += 1;
      await fs.writeFile(file, keep.length ? `${keep.map((row) => JSON.stringify(row)).join("\n")}\n` : "", "utf8");
    }

    for (const id of deletedIds) {
      this.seen.delete(id);
    }
    await this.rewriteSeenIndex();

    const result = {
      deleted_events: deletedEvents,
      files_touched: filesTouched
    };

    await this.writeAuditEntry({
      action: "events.delete",
      actor,
      details: {
        filter: {
          org_id: orgId ?? null,
          engineer_id: engineerId ?? null,
          trace_id: traceId ?? null
        },
        ...result
      }
    });

    return result;
  }

  async applyRetention(retentionDays, { actor = "system" } = {}) {
    const days = Number(retentionDays);
    if (!Number.isFinite(days) || days <= 0) {
      throw new Error("retentionDays must be a positive number");
    }

    const files = await this.listEventFiles();
    let deletedEvents = 0;
    let filesTouched = 0;
    const deletedIds = [];

    for (const file of files) {
      const rows = parseJsonLines(await fs.readFile(file, "utf8"));
      const keep = [];
      let touched = false;

      for (const row of rows) {
        if (withinRetention(row.occurred_at, days)) {
          keep.push(row);
          continue;
        }

        touched = true;
        deletedEvents += 1;
        if (row.event_id) {
          deletedIds.push(row.event_id);
        }
      }

      if (!touched) {
        continue;
      }

      filesTouched += 1;
      await fs.writeFile(file, keep.length ? `${keep.map((row) => JSON.stringify(row)).join("\n")}\n` : "", "utf8");
    }

    for (const id of deletedIds) {
      this.seen.delete(id);
    }
    await this.rewriteSeenIndex();

    const result = {
      deleted_events: deletedEvents,
      files_touched: filesTouched,
      retention_days: days
    };

    await this.writeAuditEntry({
      action: "events.retention",
      actor,
      details: result
    });

    return result;
  }

  async walkEventLines(onLine) {
    const files = await this.listEventFiles();

    for (const file of files) {
      const rows = parseJsonLines(await fs.readFile(file, "utf8"));
      for (const row of rows) {
        await onLine(row);
      }
    }
  }

  async countAllEvents() {
    let total = 0;

    await this.walkEventLines(() => {
      total += 1;
    });

    return total;
  }

  async summarizeMetadata() {
    const byOrg = new Map();
    const byTeam = new Map();
    const byEngineer = new Map();

    await this.walkEventLines((event) => {
      increment(byOrg, event.org_id);
      increment(byTeam, event.team_id ?? "unknown");
      increment(byEngineer, event.engineer_id ?? "unknown");
    });

    const orgRows = mapToSortedArray(byOrg);
    const teamRows = mapToSortedArray(byTeam);
    const engineerRows = mapToSortedArray(byEngineer);

    return {
      orgs: orgRows.length,
      teams: teamRows.length,
      engineers: engineerRows.length,
      by_org: orgRows,
      by_team: teamRows,
      by_engineer: engineerRows
    };
  }
}
