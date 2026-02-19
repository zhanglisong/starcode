import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

function nowIso() {
  return new Date().toISOString();
}

function normalizeSessionId(value) {
  const id = String(value ?? "").trim();
  if (!id) {
    throw new Error("session id is required");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error("session id may only contain letters, numbers, '.', '_', and '-'");
  }
  return id;
}

function emptySnapshot({ id, workspaceDir = "", parentSessionId = "" } = {}) {
  const timestamp = nowIso();
  return {
    version: 1,
    id,
    parent_session_id: parentSessionId || null,
    workspace_dir: workspaceDir,
    created_at: timestamp,
    updated_at: timestamp,
    messages: [],
    session_summary: "",
    turns: []
  };
}

function sanitizeMessage(message) {
  if (!message || typeof message !== "object") {
    return null;
  }
  const role = String(message.role ?? "").trim();
  if (!role) {
    return null;
  }
  const output = {
    role,
    content: message.content ?? ""
  };

  if (message.tool_call_id !== undefined) {
    output.tool_call_id = message.tool_call_id;
  }
  if (Array.isArray(message.tool_calls)) {
    output.tool_calls = message.tool_calls;
  }
  if (message.reasoning_content !== undefined) {
    output.reasoning_content = message.reasoning_content;
  }
  return output;
}

function sanitizeSnapshot(snapshot) {
  const id = normalizeSessionId(snapshot?.id ?? "");
  const messages = (Array.isArray(snapshot?.messages) ? snapshot.messages : [])
    .map(sanitizeMessage)
    .filter(Boolean);
  const turns = Array.isArray(snapshot?.turns)
    ? snapshot.turns.filter((turn) => turn && typeof turn === "object")
    : [];
  return {
    version: 1,
    id,
    parent_session_id: snapshot?.parent_session_id ? String(snapshot.parent_session_id) : null,
    workspace_dir: String(snapshot?.workspace_dir ?? ""),
    created_at: String(snapshot?.created_at ?? nowIso()),
    updated_at: String(snapshot?.updated_at ?? nowIso()),
    messages,
    session_summary: String(snapshot?.session_summary ?? ""),
    turns
  };
}

export class SessionStore {
  constructor({ baseDir } = {}) {
    if (!baseDir || typeof baseDir !== "string") {
      throw new Error("baseDir is required");
    }
    this.baseDir = path.resolve(baseDir);
  }

  async ensureDir() {
    await fs.mkdir(this.baseDir, { recursive: true });
  }

  resolveSessionPath(id) {
    const normalized = normalizeSessionId(id);
    return path.join(this.baseDir, `${normalized}.json`);
  }

  async load(id) {
    const filePath = this.resolveSessionPath(id);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      return sanitizeSnapshot(parsed);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async save(snapshot) {
    await this.ensureDir();
    const normalized = sanitizeSnapshot(snapshot);
    normalized.updated_at = nowIso();
    const filePath = this.resolveSessionPath(normalized.id);
    await fs.writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    return normalized;
  }

  async create({ id = "", parentSessionId = "", workspaceDir = "" } = {}) {
    const sessionId = normalizeSessionId(id || randomUUID());
    const existing = await this.load(sessionId);
    if (existing) {
      return existing;
    }

    const snapshot = emptySnapshot({
      id: sessionId,
      workspaceDir,
      parentSessionId
    });
    return this.save(snapshot);
  }

  async list() {
    await this.ensureDir();
    const entries = await fs.readdir(this.baseDir, { withFileTypes: true });
    const output = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const sessionId = entry.name.slice(0, -".json".length);
      const snapshot = await this.load(sessionId);
      if (!snapshot) {
        continue;
      }
      output.push({
        id: snapshot.id,
        parent_session_id: snapshot.parent_session_id,
        updated_at: snapshot.updated_at,
        created_at: snapshot.created_at,
        turns: snapshot.turns.length,
        messages: snapshot.messages.length
      });
    }

    output.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return output;
  }

  async delete(id) {
    const filePath = this.resolveSessionPath(id);
    await fs.rm(filePath, { force: true });
    return {
      ok: true,
      id: normalizeSessionId(id)
    };
  }

  async appendTurn({
    id,
    traceId,
    inputText,
    outputText,
    usage,
    latencyMs,
    status,
    toolCalls,
    toolResults,
    messages,
    sessionSummary
  } = {}) {
    const sessionId = normalizeSessionId(id);
    const existing = (await this.load(sessionId)) ?? emptySnapshot({ id: sessionId });
    const entry = {
      trace_id: String(traceId ?? ""),
      ts: nowIso(),
      status: String(status ?? "ok"),
      input_text: String(inputText ?? ""),
      output_text: String(outputText ?? ""),
      usage: usage && typeof usage === "object" ? usage : {},
      latency_ms: Number.isFinite(Number(latencyMs)) ? Number(latencyMs) : 0,
      tool_calls: Array.isArray(toolCalls) ? toolCalls : [],
      tool_results: Array.isArray(toolResults) ? toolResults : []
    };

    existing.turns.push(entry);
    existing.messages = (Array.isArray(messages) ? messages : [])
      .map(sanitizeMessage)
      .filter(Boolean);
    existing.session_summary = String(sessionSummary ?? existing.session_summary ?? "");

    return this.save(existing);
  }

  async fork(sourceId, { id = "" } = {}) {
    const source = await this.load(sourceId);
    if (!source) {
      throw new Error(`session not found: ${sourceId}`);
    }
    const targetId = normalizeSessionId(id || randomUUID());
    const target = {
      ...source,
      id: targetId,
      parent_session_id: source.id,
      created_at: nowIso(),
      updated_at: nowIso()
    };
    return this.save(target);
  }
}
