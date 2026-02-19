import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { loadHistory, normalizeHistoryEntries, saveHistory } from "../src/cli/historyStore.js";

test("normalizeHistoryEntries filters blanks and enforces max", () => {
  const result = normalizeHistoryEntries(["", "  ", "first", "second", "third"], 2);
  assert.deepEqual(result, ["second", "third"]);
});

test("saveHistory and loadHistory round-trip", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "starcode-history-"));
  const filePath = path.join(dir, "history.txt");

  await saveHistory(filePath, [" one ", "two", "", "three"], 10);
  const loaded = await loadHistory(filePath, 10);

  assert.deepEqual(loaded, ["one", "two", "three"]);
});

test("loadHistory returns empty array when file does not exist", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "starcode-history-missing-"));
  const filePath = path.join(dir, "missing.txt");

  const loaded = await loadHistory(filePath, 10);
  assert.deepEqual(loaded, []);
});
