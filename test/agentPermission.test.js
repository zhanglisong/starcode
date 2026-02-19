import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StarcodeAgent } from "../src/agent/starcodeAgent.js";
import { LocalFileTools } from "../src/tools/localFileTools.js";

class ToolThenFinishProvider {
  constructor() {
    this.providerName = "tool-then-finish";
    this.calls = 0;
  }

  async complete({ messages }) {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        outputText: "",
        message: {
          role: "assistant",
          content: ""
        },
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "p1",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({ path: "blocked.txt", content: "x" })
            }
          }
        ],
        usage: { total_tokens: 1 }
      };
    }

    const toolMessage = messages.find((item) => item.role === "tool");
    const payload = JSON.parse(toolMessage.content);
    assert.equal(payload.denied, true);

    return {
      outputText: "permission handled",
      message: {
        role: "assistant",
        content: "permission handled"
      },
      finishReason: "stop",
      toolCalls: [],
      usage: { total_tokens: 2 }
    };
  }
}

function telemetryStub() {
  const state = {
    turns: []
  };
  return {
    state,
    async captureConversationTurn(payload) {
      state.turns.push(payload);
    },
    async captureModelBehavior() {},
    async flush() {
      return { flushed: 0 };
    }
  };
}

test("agent enforces permission manager decision before tool execution", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "starcode-agent-permission-"));
  const provider = new ToolThenFinishProvider();
  const telemetry = telemetryStub();

  const agent = new StarcodeAgent({
    provider,
    telemetry,
    localTools: new LocalFileTools({ baseDir: dir }),
    permissionManager: {
      async authorizeToolCall() {
        return {
          allowed: false,
          decision: "deny",
          source: "rule",
          mode: "rule",
          reason: "blocked",
          request: {
            permission: "edit",
            patterns: ["blocked.txt"]
          },
          denied_rule: {
            permission: "edit",
            pattern: "blocked.txt",
            source: "test"
          }
        };
      }
    },
    model: "test",
    systemPrompt: "You are a test agent."
  });

  const result = await agent.runTurn("write blocked file");
  assert.equal(result.outputText, "permission handled");

  await assert.rejects(async () => fs.readFile(path.join(dir, "blocked.txt"), "utf8"), /ENOENT/);

  const toolResults = telemetry.state.turns[0].toolResults;
  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0].denied, true);
  assert.equal(toolResults[0].permission.reason, "blocked");
});
