import fs from "node:fs/promises";
import path from "node:path";

function toHistoryLine(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).replace(/\r/g, "").replace(/[\n\u0000]+/g, " ");
}

function clampHistoryLimit(value, fallback = 500) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.round(parsed));
}

export function normalizeHistoryEntries(entries, maxEntries = 500) {
  const limit = clampHistoryLimit(maxEntries, 500);
  const list = Array.isArray(entries) ? entries : [];
  const normalized = [];

  for (const entry of list) {
    const line = toHistoryLine(entry).trim();
    if (!line) {
      continue;
    }
    normalized.push(line);
  }

  if (normalized.length <= limit) {
    return normalized;
  }

  return normalized.slice(normalized.length - limit);
}

export async function loadHistory(filePath, maxEntries = 500) {
  try {
    const body = await fs.readFile(filePath, "utf8");
    const rows = body.split("\n");
    return normalizeHistoryEntries(rows, maxEntries);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function saveHistory(filePath, entries, maxEntries = 500) {
  const normalized = normalizeHistoryEntries(entries, maxEntries);
  const content = normalized.length > 0 ? `${normalized.join("\n")}\n` : "";
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return {
    ok: true,
    path: filePath,
    entries: normalized.length
  };
}
