import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveRuntimeMcpConfig, resolveRuntimeModelConfig, runProviderUtilityCommand } from "../src/cli/providerAuthCommands.js";

function outputBuffer() {
  let text = "";
  return {
    writer: {
      write(chunk) {
        text += String(chunk);
      }
    },
    read() {
      return text;
    }
  };
}

test("auth login/list/logout flow persists provider profiles", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "starcode-auth-cmds-"));
  const storePath = path.join(root, "profiles.json");
  const out = outputBuffer();

  await runProviderUtilityCommand({
    argv: [
      "auth",
      "login",
      "moonshot",
      "--api-key",
      "sk-abcdefghijklmnopqrstuvwxyz",
      "--endpoint",
      "https://api.moonshot.ai/v1/chat/completions",
      "--model",
      "kimi-k2.5"
    ],
    output: out.writer,
    env: {},
    storePath
  });

  assert.match(out.read(), /auth login ok provider=moonshot/);

  const outList = outputBuffer();
  await runProviderUtilityCommand({
    argv: ["auth", "list"],
    output: outList.writer,
    env: {},
    storePath
  });
  assert.match(outList.read(), /defaults provider=moonshot model=kimi-k2.5/);
  assert.match(outList.read(), /api_key=sk-/);

  const outLogout = outputBuffer();
  await runProviderUtilityCommand({
    argv: ["auth", "logout", "moonshot"],
    output: outLogout.writer,
    env: {},
    storePath
  });
  assert.match(outLogout.read(), /auth logout ok provider=moonshot/);
});

test("models list uses provider catalog and models use sets defaults", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "starcode-models-cmds-"));
  const storePath = path.join(root, "profiles.json");

  await runProviderUtilityCommand({
    argv: ["auth", "login", "openai-compatible", "--api-key", "sk-test"],
    output: outputBuffer().writer,
    env: {},
    storePath
  });

  const listOut = outputBuffer();
  await runProviderUtilityCommand({
    argv: ["models", "list"],
    output: listOut.writer,
    env: {},
    storePath,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          data: [{ id: "gpt-4.1-mini" }, { id: "o3-mini" }]
        };
      },
      async text() {
        return "";
      }
    })
  });

  assert.match(listOut.read(), /models=2/);
  assert.match(listOut.read(), /gpt-4.1-mini/);
  assert.match(listOut.read(), /o3-mini/);

  const useOut = outputBuffer();
  await runProviderUtilityCommand({
    argv: ["models", "use", "o3-mini"],
    output: useOut.writer,
    env: {},
    storePath
  });
  assert.match(useOut.read(), /models use ok provider=openai-compatible model=o3-mini/);

  const runtime = await resolveRuntimeModelConfig({
    env: {},
    storePath
  });
  assert.equal(runtime.provider, "openai-compatible");
  assert.equal(runtime.model, "o3-mini");
});

test("runProviderUtilityCommand returns false for non-utility command", async () => {
  const handled = await runProviderUtilityCommand({
    argv: ["not-a-command"],
    output: outputBuffer().writer,
    env: {}
  });
  assert.equal(handled, false);
});

test("mcp add/list/disable/enable/remove flow persists MCP server config", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "starcode-mcp-cmds-"));
  const storePath = path.join(root, "profiles.json");

  const addOut = outputBuffer();
  await runProviderUtilityCommand({
    argv: [
      "mcp",
      "add",
      "demo",
      "--endpoint",
      "http://127.0.0.1:9011",
      "--header",
      "x-api-key:${DEMO_KEY}",
      "--api-key-env",
      "DEMO_KEY",
      "--version",
      "2026-02"
    ],
    output: addOut.writer,
    env: {
      DEMO_KEY: "abc123"
    },
    storePath
  });
  assert.match(addOut.read(), /mcp add ok id=demo/);

  const listOut = outputBuffer();
  await runProviderUtilityCommand({
    argv: ["mcp", "list"],
    output: listOut.writer,
    env: {},
    storePath
  });
  assert.match(listOut.read(), /mcp_servers=1/);
  assert.match(listOut.read(), /demo enabled=true type=http endpoint=http:\/\/127.0.0.1:9011 version=2026-02/);

  const disableOut = outputBuffer();
  await runProviderUtilityCommand({
    argv: ["mcp", "disable", "demo"],
    output: disableOut.writer,
    env: {},
    storePath
  });
  assert.match(disableOut.read(), /mcp disable ok id=demo/);

  const runtimeDisabled = await resolveRuntimeMcpConfig({
    env: {},
    storePath
  });
  assert.equal(runtimeDisabled.servers.length, 0);

  await runProviderUtilityCommand({
    argv: ["mcp", "enable", "demo"],
    output: outputBuffer().writer,
    env: {},
    storePath
  });

  const runtime = await resolveRuntimeMcpConfig({
    env: {},
    storePath
  });
  assert.equal(runtime.servers.length, 1);
  assert.equal(runtime.servers[0].id, "demo");
  assert.equal(runtime.servers[0].api_key_env, "DEMO_KEY");

  const removeOut = outputBuffer();
  await runProviderUtilityCommand({
    argv: ["mcp", "remove", "demo"],
    output: removeOut.writer,
    env: {},
    storePath
  });
  assert.match(removeOut.read(), /mcp remove ok id=demo/);
});
