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

      const result = await storage.writeEvents(valid);
      return json(res, 202, {
        accepted: result.accepted,
        deduplicated: result.deduplicated,
        rejected: events.length - valid.length
      });
    }

    return json(res, 404, { error: "not found" });
  } catch (error) {
    return json(res, 500, { error: error.message });
  }
});

server.listen(PORT, HOST, async () => {
  await storage.init();
  process.stdout.write(
    `Starcode ingestor listening on http://${HOST}:${PORT} (storage=${STORAGE_DIR})\n`
  );
});
