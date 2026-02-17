import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalFileTools } from "../src/tools/localFileTools.js";

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "starcode-tools-"));
}

test("write_file then read_file works", async () => {
  const dir = await makeTempDir();
  const tools = new LocalFileTools({ baseDir: dir });

  const writeResult = await tools.writeFile({
    path: "notes/todo.txt",
    content: "hello"
  });

  assert.equal(writeResult.ok, true);
  assert.equal(writeResult.path, "notes/todo.txt");

  const readResult = await tools.readFile({ path: "notes/todo.txt" });
  assert.equal(readResult.ok, true);
  assert.equal(readResult.content, "hello");
});

test("list_files returns entries", async () => {
  const dir = await makeTempDir();
  const tools = new LocalFileTools({ baseDir: dir });

  await tools.writeFile({ path: "a.txt", content: "a" });
  await tools.writeFile({ path: "sub/b.txt", content: "b" });

  const listResult = await tools.listFiles({ path: ".", recursive: true });
  const paths = listResult.entries.map((entry) => entry.path);

  assert.equal(listResult.ok, true);
  assert.equal(paths.includes("a.txt"), true);
  assert.equal(paths.includes("sub/b.txt"), true);
});

test("path traversal is blocked", async () => {
  const dir = await makeTempDir();
  const tools = new LocalFileTools({ baseDir: dir });

  await assert.rejects(async () => {
    await tools.readFile({ path: "../secret.txt" });
  }, /outside workspace/);
});
