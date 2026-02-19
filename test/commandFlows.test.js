import test from "node:test";
import assert from "node:assert/strict";
import { parseSlashCommand, renderSlashHelpText } from "../src/cli/commandFlows.js";

test("parseSlashCommand returns null for normal input", () => {
  assert.equal(parseSlashCommand("hello world"), null);
});

test("parseSlashCommand builds /fix workflow prompt", () => {
  const parsed = parseSlashCommand("/fix flaky login test");
  assert.equal(parsed.kind, "command");
  assert.equal(parsed.command, "fix");
  assert.equal(parsed.args, "flaky login test");
  assert.match(parsed.prompt, /^Workflow: \/fix/m);
  assert.match(parsed.prompt, /User issue to fix: flaky login test/);
  assert.match(parsed.prompt, /Execution steps \(follow in order\):/);
});

test("parseSlashCommand builds /test workflow with default command", () => {
  const parsed = parseSlashCommand("/test");
  assert.equal(parsed.kind, "command");
  assert.equal(parsed.command, "test");
  assert.match(parsed.prompt, /Primary test command: npm test/);
});

test("parseSlashCommand keeps explicit /test command arguments", () => {
  const parsed = parseSlashCommand("/test npm run test:unit");
  assert.equal(parsed.kind, "command");
  assert.equal(parsed.command, "test");
  assert.match(parsed.prompt, /Primary test command: npm run test:unit/);
});

test("parseSlashCommand builds /commit workflow with message handling", () => {
  const parsed = parseSlashCommand("/commit chore: tighten parser");
  assert.equal(parsed.kind, "command");
  assert.equal(parsed.command, "commit");
  assert.match(parsed.prompt, /Requested commit message: chore: tighten parser/);
  assert.match(parsed.prompt, /If no commit message is provided, propose one and stop without committing\./);
});

test("parseSlashCommand returns help sentinel for /help", () => {
  const parsed = parseSlashCommand("/help");
  assert.deepEqual(parsed, {
    kind: "help",
    command: "help",
    args: ""
  });
});

test("parseSlashCommand returns status sentinel for /status", () => {
  const parsed = parseSlashCommand("/status");
  assert.deepEqual(parsed, {
    kind: "status",
    command: "status",
    args: ""
  });
});

test("parseSlashCommand returns unknown sentinel for unsupported slash command", () => {
  const parsed = parseSlashCommand("/unknown x");
  assert.deepEqual(parsed, {
    kind: "unknown",
    command: "unknown",
    args: "x"
  });
});

test("renderSlashHelpText lists all workflow commands", () => {
  const help = renderSlashHelpText();
  assert.match(help, /\/fix/);
  assert.match(help, /\/test/);
  assert.match(help, /\/explain/);
  assert.match(help, /\/commit/);
  assert.match(help, /\/status/);
  assert.match(help, /\/help/);
});
