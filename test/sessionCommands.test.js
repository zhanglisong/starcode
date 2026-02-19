import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../src/session/store.js";
import { runSessionCommand } from "../src/cli/sessionCommands.js";

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

test("session command list/delete/fork operations", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "starcode-session-commands-"));
  const sessionDir = path.join(workspaceDir, ".telemetry", "sessions");
  const store = new SessionStore({ baseDir: sessionDir });

  await store.create({ id: "base", workspaceDir });
  await store.appendTurn({
    id: "base",
    traceId: "t1",
    inputText: "hello",
    outputText: "world",
    usage: {},
    latencyMs: 1,
    status: "ok",
    toolCalls: [],
    toolResults: [],
    messages: [{ role: "system", content: "x" }],
    sessionSummary: ""
  });

  const listOut = outputBuffer();
  await runSessionCommand(["list"], {
    output: listOut.writer,
    workspaceDir,
    sessionDir
  });
  assert.match(listOut.read(), /sessions=1/);
  assert.match(listOut.read(), /base/);

  const forkOut = outputBuffer();
  await runSessionCommand(["fork", "base", "--session", "child"], {
    output: forkOut.writer,
    workspaceDir,
    sessionDir
  });
  assert.match(forkOut.read(), /session fork ok source=base id=child parent=base/);

  const deleteOut = outputBuffer();
  await runSessionCommand(["delete", "child"], {
    output: deleteOut.writer,
    workspaceDir,
    sessionDir
  });
  assert.match(deleteOut.read(), /session delete ok id=child/);
});
