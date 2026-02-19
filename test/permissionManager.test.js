import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PermissionManager } from "../src/permission/permissionManager.js";
import { RuntimeApprovalStore } from "../src/permission/runtimeApprovalStore.js";

function makeToolCall(name, args) {
  return {
    function: {
      name,
      arguments: JSON.stringify(args ?? {})
    }
  };
}

test("permission manager supports once approval", async () => {
  const manager = new PermissionManager({
    onAsk: async () => ({ reply: "once" })
  });

  const result = await manager.authorizeToolCall(
    makeToolCall("write_file", {
      path: "a.txt",
      content: "x"
    })
  );

  assert.equal(result.allowed, true);
  assert.equal(result.mode, "once");
  assert.equal(result.request.permission, "edit");
});

test("permission manager persists always approvals and reuses them", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "starcode-permissions-"));
  const store = new RuntimeApprovalStore({
    filePath: path.join(root, "permissions.json")
  });

  const manager = new PermissionManager({
    store,
    onAsk: async () => ({ reply: "always" })
  });

  const first = await manager.authorizeToolCall(
    makeToolCall("execute_shell", {
      command: "npm test"
    })
  );
  assert.equal(first.allowed, true);
  assert.equal(first.mode, "always");

  const managerReloaded = new PermissionManager({
    store
  });
  const second = await managerReloaded.authorizeToolCall(
    makeToolCall("execute_shell", {
      command: "echo hi"
    })
  );

  assert.equal(second.allowed, true);
  assert.equal(second.mode, "rule");
  assert.equal(second.source, "rule");
});

test("permission manager returns machine-readable deny with source rule", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "starcode-permissions-deny-"));
  const store = new RuntimeApprovalStore({
    filePath: path.join(root, "permissions.json")
  });
  await store.upsertRule({
    permission: "edit",
    pattern: "forbidden.txt",
    action: "deny",
    source: "test-policy"
  });

  const manager = new PermissionManager({ store });
  const result = await manager.authorizeToolCall(
    makeToolCall("write_file", {
      path: "forbidden.txt",
      content: "blocked"
    })
  );

  assert.equal(result.allowed, false);
  assert.equal(result.mode, "rule");
  assert.equal(result.denied_rule.permission, "edit");
  assert.equal(result.denied_rule.pattern, "forbidden.txt");
  assert.equal(result.denied_rule.source, "test-policy");
});
