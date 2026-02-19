import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalFileTools } from "../src/tools/localFileTools.js";

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "starcode-apply-patch-"));
}

test("apply_patch supports add/update/move/delete in one patch", async () => {
  const dir = await makeTempDir();
  const tools = new LocalFileTools({ baseDir: dir });

  await fs.writeFile(path.join(dir, "update.txt"), "before\n", "utf8");
  await fs.writeFile(path.join(dir, "move.txt"), "rename-me\n", "utf8");
  await fs.writeFile(path.join(dir, "delete.txt"), "remove-me\n", "utf8");

  const patch = [
    "*** Begin Patch",
    "*** Add File: add.txt",
    "+line-a",
    "+line-b",
    "*** Update File: update.txt",
    "@@",
    "-before",
    "+after",
    "*** Update File: move.txt",
    "*** Move to: moved.txt",
    "@@",
    "-rename-me",
    "+renamed",
    "*** Delete File: delete.txt",
    "*** End Patch"
  ].join("\n");

  const result = await tools.applyPatch({ patch });
  assert.equal(result.ok, true);
  assert.equal(result.operations_applied, 4);
  assert.equal(result.files.some((item) => item.type === "add" && item.path === "add.txt"), true);
  assert.equal(result.files.some((item) => item.type === "move" && item.path === "move.txt"), true);
  assert.equal(result.files.some((item) => item.type === "delete" && item.path === "delete.txt"), true);

  assert.equal(await fs.readFile(path.join(dir, "add.txt"), "utf8"), "line-a\nline-b");
  assert.equal(await fs.readFile(path.join(dir, "update.txt"), "utf8"), "after\n");
  assert.equal(await fs.readFile(path.join(dir, "moved.txt"), "utf8"), "renamed\n");
  await assert.rejects(async () => fs.readFile(path.join(dir, "move.txt"), "utf8"), /ENOENT/);
  await assert.rejects(async () => fs.readFile(path.join(dir, "delete.txt"), "utf8"), /ENOENT/);
});

test("apply_patch verifies all operations before writing", async () => {
  const dir = await makeTempDir();
  const tools = new LocalFileTools({ baseDir: dir });

  await fs.writeFile(path.join(dir, "base.txt"), "same\n", "utf8");
  await fs.writeFile(path.join(dir, "target.txt"), "already\n", "utf8");

  const patch = [
    "*** Begin Patch",
    "*** Add File: new.txt",
    "+new",
    "*** Update File: base.txt",
    "@@",
    "-missing",
    "+updated",
    "*** Update File: base.txt",
    "*** Move to: target.txt",
    "@@",
    "-same",
    "+same2",
    "*** End Patch"
  ].join("\n");

  await assert.rejects(async () => tools.applyPatch({ patch }), /verification failed|context not found|destination exists/i);

  assert.equal(await fs.readFile(path.join(dir, "base.txt"), "utf8"), "same\n");
  assert.equal(await fs.readFile(path.join(dir, "target.txt"), "utf8"), "already\n");
  await assert.rejects(async () => fs.readFile(path.join(dir, "new.txt"), "utf8"), /ENOENT/);
});
