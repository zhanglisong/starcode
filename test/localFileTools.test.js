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

test("create_file enforces overwrite semantics", async () => {
  const dir = await makeTempDir();
  const tools = new LocalFileTools({ baseDir: dir });

  await tools.createFile({ path: "a.txt", content: "v1" });

  await assert.rejects(async () => {
    await tools.createFile({ path: "a.txt", content: "v2" });
  }, /already exists/);

  const overwritten = await tools.createFile({
    path: "a.txt",
    content: "v3",
    overwrite: true
  });

  assert.equal(overwritten.ok, true);
  const readResult = await tools.readFile({ path: "a.txt" });
  assert.equal(readResult.content, "v3");
});

test("edit_file and replace_in_file update text", async () => {
  const dir = await makeTempDir();
  const tools = new LocalFileTools({ baseDir: dir });

  await tools.writeFile({ path: "notes.txt", content: "alpha beta alpha" });

  const first = await tools.editFile({
    path: "notes.txt",
    search: "alpha",
    replace: "ALPHA"
  });
  assert.equal(first.ok, true);
  assert.equal(first.replacements, 1);

  const all = await tools.replaceInFile({
    path: "notes.txt",
    search: "alpha",
    replace: "ALPHA",
    all: true
  });
  assert.equal(all.ok, true);
  assert.equal(all.replacements, 1);

  const readResult = await tools.readFile({ path: "notes.txt" });
  assert.equal(readResult.content, "ALPHA beta ALPHA");
});

test("insert_in_file supports line and anchor modes", async () => {
  const dir = await makeTempDir();
  const tools = new LocalFileTools({ baseDir: dir });

  await tools.writeFile({ path: "doc.txt", content: "line1\nline2\nline3" });

  const insertLine = await tools.insertInFile({
    path: "doc.txt",
    line: 2,
    content: "inserted"
  });
  assert.equal(insertLine.ok, true);
  assert.equal(insertLine.line, 2);

  const insertAnchor = await tools.insertInFile({
    path: "doc.txt",
    anchor: "line3",
    position: "before",
    content: "before3"
  });
  assert.equal(insertAnchor.ok, true);

  const readResult = await tools.readFile({ path: "doc.txt" });
  assert.equal(readResult.content, "line1\ninserted\nline2\nbefore3\nline3");
});

test("patch_file applies unified diff hunks", async () => {
  const dir = await makeTempDir();
  const tools = new LocalFileTools({ baseDir: dir });

  await tools.writeFile({ path: "patch.txt", content: "a\nb\nc\n" });

  const patch = [
    "@@ -1,3 +1,3 @@",
    " a",
    "-b",
    "+B",
    " c"
  ].join("\n");

  const result = await tools.patchFile({ path: "patch.txt", unified_diff: patch });
  assert.equal(result.ok, true);
  assert.equal(result.hunks_applied, 1);

  const readResult = await tools.readFile({ path: "patch.txt" });
  assert.equal(readResult.content, "a\nB\nc\n");
});

test("patch_file fails on mismatch", async () => {
  const dir = await makeTempDir();
  const tools = new LocalFileTools({ baseDir: dir });

  await tools.writeFile({ path: "patch.txt", content: "a\nb\nc\n" });

  const patch = [
    "@@ -1,3 +1,3 @@",
    " a",
    "-x",
    "+B",
    " c"
  ].join("\n");

  await assert.rejects(async () => {
    await tools.patchFile({ path: "patch.txt", unified_diff: patch });
  }, /Patch delete mismatch/);
});

test("move_file and delete_file work", async () => {
  const dir = await makeTempDir();
  const tools = new LocalFileTools({ baseDir: dir });

  await tools.writeFile({ path: "src/a.txt", content: "x" });

  const moved = await tools.moveFile({ from: "src/a.txt", to: "dst/b.txt" });
  assert.equal(moved.ok, true);
  assert.equal(moved.moved, true);

  const readMoved = await tools.readFile({ path: "dst/b.txt" });
  assert.equal(readMoved.content, "x");

  const deleted = await tools.deleteFile({ path: "dst/b.txt" });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.type, "file");

  await assert.rejects(async () => {
    await tools.readFile({ path: "dst/b.txt" });
  }, /ENOENT/);
});

test("delete_file requires recursive=true for directories", async () => {
  const dir = await makeTempDir();
  const tools = new LocalFileTools({ baseDir: dir });

  await tools.writeFile({ path: "dir/x.txt", content: "x" });

  await assert.rejects(async () => {
    await tools.deleteFile({ path: "dir" });
  }, /recursive=true/);

  const deleted = await tools.deleteFile({ path: "dir", recursive: true });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.type, "dir");
});

test("glob_files matches files by pattern", async () => {
  const dir = await makeTempDir();
  const tools = new LocalFileTools({ baseDir: dir });

  await tools.writeFile({ path: "src/a.js", content: "a" });
  await tools.writeFile({ path: "src/b.ts", content: "b" });
  await tools.writeFile({ path: "src/lib/c.js", content: "c" });

  const glob = await tools.globFiles({ pattern: "src/**/*.js" });
  const paths = glob.matches.map((item) => item.path).sort();

  assert.equal(glob.ok, true);
  assert.deepEqual(paths, ["src/a.js", "src/lib/c.js"]);
});

test("grep_files finds text and returns line metadata", async () => {
  const dir = await makeTempDir();
  const tools = new LocalFileTools({ baseDir: dir });

  await tools.writeFile({ path: "src/a.txt", content: "hello\nworld" });
  await tools.writeFile({ path: "src/b.txt", content: "HELLO" });

  const grepInsensitive = await tools.grepFiles({ pattern: "hello", path: "src" });
  assert.equal(grepInsensitive.ok, true);
  assert.equal(grepInsensitive.count, 2);

  const grepSensitive = await tools.grepFiles({
    pattern: "hello",
    path: "src",
    case_sensitive: true
  });
  assert.equal(grepSensitive.count, 1);
  assert.equal(grepSensitive.matches[0].path, "src/a.txt");
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

test("executeToolCall supports new tool names", async () => {
  const dir = await makeTempDir();
  const tools = new LocalFileTools({ baseDir: dir });

  const result = await tools.executeToolCall({
    function: {
      name: "create_file",
      arguments: JSON.stringify({ path: "x.txt", content: "x" })
    }
  });

  assert.equal(result.ok, true);
  const readResult = await tools.readFile({ path: "x.txt" });
  assert.equal(readResult.content, "x");
});

test("path traversal is blocked", async () => {
  const dir = await makeTempDir();
  const tools = new LocalFileTools({ baseDir: dir });

  await assert.rejects(async () => {
    await tools.readFile({ path: "../secret.txt" });
  }, /outside workspace/);

  await assert.rejects(async () => {
    await tools.moveFile({ from: "a.txt", to: "../oops.txt" });
  }, /outside workspace/);
});
