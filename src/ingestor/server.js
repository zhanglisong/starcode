#!/usr/bin/env node
import http from "node:http";
import { IngestStorage } from "./storage.js";
import { isValidEvent } from "../telemetry/eventSchema.js";

const PORT = Number(process.env.INGEST_PORT ?? 8787);
const HOST = process.env.INGEST_HOST ?? "0.0.0.0";
const STORAGE_DIR = process.env.INGEST_STORAGE_DIR ?? "data/ingested";
const API_KEYS = new Set(
  (process.env.INGEST_API_KEYS ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
);
const OPT_IN_ORGS = new Set(
  (process.env.INGEST_OPT_IN_ORGS ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
);
const RETENTION_DAYS = Number(process.env.INGEST_RETENTION_DAYS ?? 0);

const storage = new IngestStorage(STORAGE_DIR);

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text)
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 20 * 1024 * 1024) {
        reject(new Error("body too large"));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function authorized(req) {
  if (API_KEYS.size === 0) {
    return true;
  }

  const key = req.headers["x-company-api-key"];
  return typeof key === "string" && API_KEYS.has(key);
}

function isOrgOptedIn(orgId) {
  if (OPT_IN_ORGS.size === 0) {
    return true;
  }
  return OPT_IN_ORGS.has(String(orgId ?? ""));
}

function requestActor(req) {
  const actorHeader = req.headers["x-engineer-id"];
  if (typeof actorHeader === "string" && actorHeader.trim()) {
    return actorHeader.trim();
  }
  return "admin";
}

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url || !req.method) {
      return json(res, 400, { error: "invalid request" });
    }

    if (req.method === "GET" && req.url === "/health") {
      const total = await storage.countAllEvents();
      const summary = await storage.summarizeMetadata();
      return json(res, 200, {
        ok: true,
        total_events: total,
        metadata: summary,
        governance: {
          opt_in_orgs: [...OPT_IN_ORGS.values()],
          retention_days: Number.isFinite(RETENTION_DAYS) && RETENTION_DAYS > 0 ? RETENTION_DAYS : null
        },
        time: new Date().toISOString()
      });
    }

    if (req.method === "POST" && req.url === "/v1/events") {
      if (!authorized(req)) {
        return json(res, 401, { error: "unauthorized" });
      }

      const raw = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(raw || "{}");
      } catch {
        return json(res, 400, { error: "invalid json" });
      }

      const events = Array.isArray(parsed.events) ? parsed.events : [];
      if (!events.length) {
        return json(res, 400, { error: "events[] required" });
      }

      const valid = events.filter((event) => isValidEvent(event));
      if (!valid.length) {
        return json(res, 400, { error: "no valid events" });
      }

      const optedIn = valid.filter((event) => isOrgOptedIn(event.org_id));
      const rejectedOptOut = valid.length - optedIn.length;

      if (!optedIn.length) {
        return json(res, 202, {
          accepted: 0,
          deduplicated: 0,
          rejected_invalid: events.length - valid.length,
          rejected_opt_out: rejectedOptOut,
          rejected: events.length
        });
      }

      const result = await storage.writeEvents(optedIn);
      return json(res, 202, {
        accepted: result.accepted,
        deduplicated: result.deduplicated,
        rejected_invalid: events.length - valid.length,
        rejected_opt_out: rejectedOptOut,
        rejected: events.length - optedIn.length
      });
    }

    if (req.method === "POST" && req.url === "/v1/admin/delete") {
      if (!authorized(req)) {
        return json(res, 401, { error: "unauthorized" });
      }

      const raw = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(raw || "{}");
      } catch {
        return json(res, 400, { error: "invalid json" });
      }

      const result = await storage.deleteEvents({
        orgId: parsed.org_id,
        engineerId: parsed.engineer_id,
        traceId: parsed.trace_id,
        actor: requestActor(req)
      });

      return json(res, 200, {
        ok: true,
        ...result
      });
    }

    if (req.method === "POST" && req.url === "/v1/admin/retention/apply") {
      if (!authorized(req)) {
        return json(res, 401, { error: "unauthorized" });
      }

      const raw = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(raw || "{}");
      } catch {
        return json(res, 400, { error: "invalid json" });
      }

      const days = Number.isFinite(Number(parsed.days)) ? Number(parsed.days) : RETENTION_DAYS;
      if (!Number.isFinite(days) || days <= 0) {
        return json(res, 400, { error: "positive retention days required" });
      }

      const result = await storage.applyRetention(days, {
        actor: requestActor(req)
      });

      return json(res, 200, {
        ok: true,
        ...result
      });
    }

    return json(res, 404, { error: "not found" });
  } catch (error) {
    return json(res, 500, { error: error.message });
  }
});

server.listen(PORT, HOST, async () => {
  await storage.init();

  if (Number.isFinite(RETENTION_DAYS) && RETENTION_DAYS > 0) {
    try {
      const result = await storage.applyRetention(RETENTION_DAYS, { actor: "startup" });
      process.stdout.write(`Retention applied on startup: deleted=${result.deleted_events}\n`);
    } catch (error) {
      process.stdout.write(`Retention startup apply failed: ${error.message}\n`);
    }
  }

  process.stdout.write(
    `Starcode ingestor listening on http://${HOST}:${PORT} (storage=${STORAGE_DIR}) opt_in_orgs=${
      OPT_IN_ORGS.size ? [...OPT_IN_ORGS.values()].join(",") : "ALL"
    } retention_days=${Number.isFinite(RETENTION_DAYS) && RETENTION_DAYS > 0 ? RETENTION_DAYS : "off"}\n`
  );
});
