import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StarcodeAgent } from "../src/agent/starcodeAgent.js";
import { LocalFileTools } from "../src/tools/localFileTools.js";

class StubProvider {
  constructor() {
    this.providerName = "stub";
    this.calls = 0;
  }

  async complete() {
    this.calls += 1;

    if (this.calls === 1) {
      return {
        outputText: "",
        message: {
          role: "assistant",
          content: "",
          reasoning_content: "Need to write a file first."
        },
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({
                path: "generated.txt",
                content: "hello from tool"
              })
            }
          }
        ],
        usage: { total_tokens: 10 }
      };
    }

    return {
      outputText: "Created file successfully.",
      message: {
        role: "assistant",
        content: "Created file successfully."
      },
      finishReason: "stop",
      toolCalls: [],
      usage: { total_tokens: 20 }
    };
  }
}

class ReasoningAwareProvider {
  constructor() {
    this.providerName = "reasoning-aware";
    this.calls = 0;
  }

  async complete({ messages }) {
    this.calls += 1;

    if (this.calls === 1) {
      return {
        outputText: "",
        message: {
          role: "assistant",
          content: "",
          reasoning_content: "Need file content first."
        },
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "call_reasoning_1",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({
                path: "reasoning.txt",
                content: "reasoning-compatible"
              })
            }
          }
        ],
        usage: { total_tokens: 5 }
      };
    }

    const assistantToolMessage = messages.find(
      (message) => message?.role === "assistant" && Array.isArray(message?.tool_calls)
    );

    if (!assistantToolMessage || !assistantToolMessage.reasoning_content) {
      throw new Error("assistant tool call message is missing reasoning_content");
    }

    return {
      outputText: "Done.",
      message: {
        role: "assistant",
        content: "Done."
      },
      finishReason: "stop",
      toolCalls: [],
      usage: { total_tokens: 8 }
    };
  }
}

function telemetryStub() {
  const state = {
    conversationTurns: [],
    modelBehaviorEvents: []
  };

  return {
    state,
    async captureConversationTurn(payload) {
      state.conversationTurns.push(payload);
    },
    async captureModelBehavior(payload) {
      state.modelBehaviorEvents.push(payload);
    },
    async flush() {
      return { flushed: 0, skipped: true };
    }
  };
}

test("agent executes tool calls and returns final answer", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "starcode-agent-tools-"));
  const provider = new StubProvider();
  const tools = new LocalFileTools({ baseDir: dir });
  const telemetry = telemetryStub();

  const agent = new StarcodeAgent({
    provider,
    telemetry,
    localTools: tools,
    model: "stub-model",
    systemPrompt: "You are a test agent."
  });

  const result = await agent.runTurn("please create a file");

  assert.equal(result.outputText, "Created file successfully.");
  const content = await fs.readFile(path.join(dir, "generated.txt"), "utf8");
  assert.equal(content, "hello from tool");

  assert.equal(telemetry.state.conversationTurns.length, 1);
  assert.equal(telemetry.state.modelBehaviorEvents.length, 1);

  const toolResults = telemetry.state.conversationTurns[0].toolResults;
  assert.equal(Array.isArray(toolResults), true);
  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0].name, "write_file");
  assert.equal(toolResults[0].ok, true);
  assert.equal(toolResults[0].result.path, "generated.txt");
});

test("agent preserves reasoning_content in assistant tool-call messages", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "starcode-agent-reasoning-"));
  const provider = new ReasoningAwareProvider();
  const tools = new LocalFileTools({ baseDir: dir });

  const agent = new StarcodeAgent({
    provider,
    telemetry: telemetryStub(),
    localTools: tools,
    model: "kimi-k2.5",
    systemPrompt: "You are a test agent."
  });

  const result = await agent.runTurn("create reasoning file");
  assert.equal(result.outputText, "Done.");

  const content = await fs.readFile(path.join(dir, "reasoning.txt"), "utf8");
  assert.equal(content, "reasoning-compatible");
});
