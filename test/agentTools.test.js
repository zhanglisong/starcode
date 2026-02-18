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

class MultiRoundProvider {
  constructor() {
    this.providerName = "multi-round";
    this.calls = 0;
  }

  async complete() {
    this.calls += 1;

    if (this.calls <= 3) {
      const content = this.calls === 1 ? "a" : this.calls === 2 ? "b" : "c";
      return {
        outputText: "",
        message: {
          role: "assistant",
          content: ""
        },
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: `chain_${this.calls}`,
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({
                path: "chain.txt",
                content,
                append: true
              })
            }
          }
        ],
        usage: { total_tokens: this.calls * 10 }
      };
    }

    return {
      outputText: "Chain complete.",
      message: {
        role: "assistant",
        content: "Chain complete."
      },
      finishReason: "stop",
      toolCalls: [],
      usage: { total_tokens: 50 }
    };
  }
}

class MaxRoundProvider {
  constructor() {
    this.providerName = "max-round";
    this.calls = 0;
  }

  async complete() {
    this.calls += 1;
    return {
      outputText: "",
      message: {
        role: "assistant",
        content: ""
      },
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: `limit_${this.calls}`,
          type: "function",
          function: {
            name: "write_file",
            arguments: JSON.stringify({
              path: "limit.txt",
              content: String(this.calls),
              append: true
            })
          }
        }
      ],
      usage: { total_tokens: this.calls * 10 }
    };
  }
}

class DuplicateToolProvider {
  constructor() {
    this.providerName = "duplicate-tools";
    this.calls = 0;
  }

  async complete() {
    this.calls += 1;

    if (this.calls === 1) {
      const argumentsJson = JSON.stringify({
        path: "dup.txt",
        content: "x",
        append: true
      });

      return {
        outputText: "",
        message: {
          role: "assistant",
          content: ""
        },
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "dup_1",
            type: "function",
            function: {
              name: "write_file",
              arguments: argumentsJson
            }
          },
          {
            id: "dup_2",
            type: "function",
            function: {
              name: "write_file",
              arguments: argumentsJson
            }
          }
        ],
        usage: { total_tokens: 10 }
      };
    }

    return {
      outputText: "Done dedupe.",
      message: {
        role: "assistant",
        content: "Done dedupe."
      },
      finishReason: "stop",
      toolCalls: [],
      usage: { total_tokens: 20 }
    };
  }
}

class ContextProbeProvider {
  constructor() {
    this.providerName = "context-probe";
    this.capturedMessages = null;
  }

  async complete({ messages }) {
    this.capturedMessages = messages;
    return {
      outputText: "Context received.",
      message: {
        role: "assistant",
        content: "Context received."
      },
      finishReason: "stop",
      toolCalls: [],
      usage: { total_tokens: 5 }
    };
  }
}

class StreamingProvider {
  constructor() {
    this.providerName = "streaming";
    this.calls = [];
  }

  async complete({ stream, onDelta }) {
    this.calls.push(stream === true ? "stream" : "non-stream");

    if (stream) {
      onDelta?.({ type: "text", text: "Hello " });
      onDelta?.({ type: "text", text: "stream" });
    }

    return {
      outputText: "Hello stream",
      message: {
        role: "assistant",
        content: "Hello stream"
      },
      finishReason: "stop",
      toolCalls: [],
      usage: { total_tokens: 12 },
      raw: {
        streaming: stream === true
      }
    };
  }
}

class StreamFallbackProvider {
  constructor() {
    this.providerName = "stream-fallback";
    this.calls = [];
  }

  async complete({ stream }) {
    this.calls.push(stream === true ? "stream" : "non-stream");

    if (stream) {
      const error = new Error("stream unsupported");
      error.streamUnsupported = true;
      throw error;
    }

    return {
      outputText: "Fallback response",
      message: {
        role: "assistant",
        content: "Fallback response"
      },
      finishReason: "stop",
      toolCalls: [],
      usage: { total_tokens: 9 },
      raw: {}
    };
  }
}

class EchoHistoryProvider {
  constructor() {
    this.providerName = "echo-history";
    this.received = [];
  }

  async complete({ messages }) {
    this.received.push(messages.map((message) => ({ ...message })));
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    const content = `ack: ${lastUser?.content ?? ""}`;
    return {
      outputText: content,
      message: {
        role: "assistant",
        content
      },
      finishReason: "stop",
      toolCalls: [],
      usage: { total_tokens: 7 },
      raw: {}
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

function modelIoLoggerStub() {
  const state = {
    events: []
  };

  return {
    state,
    async log(payload) {
      state.events.push(payload);
    }
  };
}

test("agent executes tool calls and returns final answer", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "starcode-agent-tools-"));
  const provider = new StubProvider();
  const tools = new LocalFileTools({ baseDir: dir });
  const telemetry = telemetryStub();
  const modelIoLogger = modelIoLoggerStub();

  const agent = new StarcodeAgent({
    provider,
    telemetry,
    modelIoLogger,
    localTools: tools,
    model: "stub-model",
    systemPrompt: "You are a test agent."
  });

  const result = await agent.runTurn("please create a file");

  assert.equal(result.outputText, "Created file successfully.");
  assert.equal(typeof result.latencyBreakdown, "object");
  assert.equal(result.latencyBreakdown.model_calls, 2);
  assert.equal(result.latencyBreakdown.tool_calls, 1);
  assert.equal(result.latencyBreakdown.tool_failures, 0);
  assert.equal(result.latencyBreakdown.tool_rounds, 1);
  assert.equal(result.latencyBreakdown.model_ms >= 0, true);
  assert.equal(result.latencyBreakdown.tool_ms >= 0, true);

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

  const conversationBreakdown = telemetry.state.conversationTurns[0].latencyBreakdown;
  assert.equal(typeof conversationBreakdown, "object");
  assert.equal(conversationBreakdown.model_calls, 2);
  assert.equal(conversationBreakdown.tool_calls, 1);

  const behaviorBreakdown = telemetry.state.modelBehaviorEvents[0].latencyBreakdown;
  assert.equal(typeof behaviorBreakdown, "object");
  assert.equal(behaviorBreakdown.model_calls, 2);

  const turnEndEvent = modelIoLogger.state.events.find((event) => event.phase === "turn_end");
  assert.equal(typeof turnEndEvent?.latency_breakdown, "object");
  assert.equal(turnEndEvent.latency_breakdown.model_calls, 2);

  const phases = modelIoLogger.state.events.map((event) => event.phase);
  assert.equal(phases.includes("model_request"), true);
  assert.equal(phases.includes("model_response"), true);
  assert.equal(phases.includes("tool_start"), true);
  assert.equal(phases.includes("tool_result"), true);
  assert.equal(phases.includes("turn_end"), true);
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

test("agent supports 3+ tool rounds before final answer", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "starcode-agent-chain-"));
  const provider = new MultiRoundProvider();
  const tools = new LocalFileTools({ baseDir: dir });

  const agent = new StarcodeAgent({
    provider,
    telemetry: telemetryStub(),
    localTools: tools,
    model: "stub-model",
    systemPrompt: "You are a test agent.",
    maxToolRounds: 5
  });

  const result = await agent.runTurn("run chain");
  assert.equal(result.outputText, "Chain complete.");
  assert.equal(provider.calls, 4);
  assert.equal(result.latencyBreakdown.tool_rounds, 3);

  const file = await fs.readFile(path.join(dir, "chain.txt"), "utf8");
  assert.equal(file, "abc");
});

test("agent stops on max tool rounds without executing extra calls", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "starcode-agent-limit-"));
  const provider = new MaxRoundProvider();
  const tools = new LocalFileTools({ baseDir: dir });
  const telemetry = telemetryStub();

  const agent = new StarcodeAgent({
    provider,
    telemetry,
    localTools: tools,
    model: "stub-model",
    systemPrompt: "You are a test agent.",
    maxToolRounds: 1
  });

  const result = await agent.runTurn("loop forever");
  assert.equal(result.outputText, "Tool-call round limit reached before final response.");
  assert.equal(provider.calls, 2);

  const file = await fs.readFile(path.join(dir, "limit.txt"), "utf8");
  assert.equal(file, "1");

  const toolResults = telemetry.state.conversationTurns[0].toolResults;
  assert.equal(toolResults.length, 1);
});

test("agent deduplicates duplicate tool calls in same round", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "starcode-agent-dedupe-"));
  const provider = new DuplicateToolProvider();
  const tools = new LocalFileTools({ baseDir: dir });
  const telemetry = telemetryStub();

  const agent = new StarcodeAgent({
    provider,
    telemetry,
    localTools: tools,
    model: "stub-model",
    systemPrompt: "You are a test agent."
  });

  const result = await agent.runTurn("run duplicates");
  assert.equal(result.outputText, "Done dedupe.");

  const file = await fs.readFile(path.join(dir, "dup.txt"), "utf8");
  assert.equal(file, "x");

  const toolResults = telemetry.state.conversationTurns[0].toolResults;
  assert.equal(toolResults.length, 2);
  assert.equal(toolResults.filter((item) => item.reused).length, 1);
});

test("agent injects git context into model request without persisting it to history", async () => {
  const provider = new ContextProbeProvider();
  const telemetry = telemetryStub();
  const gitContextProvider = {
    async buildContext() {
      return {
        source: "git",
        branch: "main",
        changed_files: 2,
        truncated: false,
        content: "Git workspace context:\n- branch: main\n- changed_files: 2"
      };
    }
  };

  const agent = new StarcodeAgent({
    provider,
    telemetry,
    gitContextProvider,
    localTools: null,
    model: "stub-model",
    systemPrompt: "You are a test agent."
  });

  const result = await agent.runTurn("hello");
  assert.equal(result.outputText, "Context received.");

  const captured = provider.capturedMessages ?? [];
  assert.equal(captured.some((message) => message.role === "system" && String(message.content).includes("Git workspace context")), true);
  assert.equal(captured.some((message) => message.role === "user" && message.content === "hello"), true);

  assert.equal(agent.messages.some((message) => String(message.content).includes("Git workspace context")), false);
});

test("agent continues when git context provider fails", async () => {
  const provider = new ContextProbeProvider();
  const agent = new StarcodeAgent({
    provider,
    telemetry: telemetryStub(),
    gitContextProvider: {
      async buildContext() {
        throw new Error("git unavailable");
      }
    },
    localTools: null,
    model: "stub-model",
    systemPrompt: "You are a test agent."
  });

  const result = await agent.runTurn("hello");
  assert.equal(result.outputText, "Context received.");
});

test("agent emits streamed text deltas when streaming is enabled", async () => {
  const provider = new StreamingProvider();
  const chunks = [];

  const agent = new StarcodeAgent({
    provider,
    telemetry: telemetryStub(),
    localTools: null,
    model: "stub-model",
    systemPrompt: "You are a test agent.",
    enableStreaming: true
  });

  const result = await agent.runTurn("stream please", {
    stream: true,
    onTextDelta: (text) => chunks.push(text)
  });

  assert.equal(result.outputText, "Hello stream");
  assert.equal(chunks.join(""), "Hello stream");
  assert.deepEqual(provider.calls, ["stream"]);
});

test("agent falls back to non-streaming mode when provider stream is unsupported", async () => {
  const provider = new StreamFallbackProvider();
  const modelIoLogger = modelIoLoggerStub();

  const agent = new StarcodeAgent({
    provider,
    telemetry: telemetryStub(),
    modelIoLogger,
    localTools: null,
    model: "stub-model",
    systemPrompt: "You are a test agent.",
    enableStreaming: true
  });

  const result = await agent.runTurn("fallback please", { stream: true });
  assert.equal(result.outputText, "Fallback response");
  assert.deepEqual(provider.calls, ["stream", "non-stream"]);

  const fallbackEvent = modelIoLogger.state.events.find((event) => event.phase === "stream_fallback");
  assert.equal(typeof fallbackEvent?.reason, "string");
});

test("agent summarizes older session turns and keeps recent context", async () => {
  const provider = new EchoHistoryProvider();
  const modelIoLogger = modelIoLoggerStub();

  const agent = new StarcodeAgent({
    provider,
    telemetry: telemetryStub(),
    modelIoLogger,
    localTools: null,
    model: "stub-model",
    systemPrompt: "You are a test agent.",
    enableSessionSummary: true,
    sessionSummaryTriggerMessages: 4,
    sessionSummaryKeepRecent: 2
  });

  await agent.runTurn("task one");
  await agent.runTurn("task two");
  const turnThree = await agent.runTurn("task three");
  await agent.runTurn("task four");

  assert.equal(typeof turnThree.sessionSummary, "object");
  const summaryMessage = agent.messages.find(
    (message) => message.role === "system" && String(message.content).startsWith("Session memory summary:")
  );
  assert.equal(Boolean(summaryMessage), true);
  assert.match(summaryMessage.content, /task one/);
  assert.match(summaryMessage.content, /task two/);

  const lastRequestMessages = provider.received.at(-1) ?? [];
  assert.equal(
    lastRequestMessages.some(
      (message) => message.role === "system" && String(message.content).startsWith("Session memory summary:")
    ),
    true
  );

  const summaryEvent = modelIoLogger.state.events.find((event) => event.phase === "session_summary_update");
  assert.equal(Boolean(summaryEvent), true);
});

test("agent planning mode emits plan and injects it into execution context", async () => {
  const provider = new ContextProbeProvider();
  const plans = [];

  const agent = new StarcodeAgent({
    provider,
    telemetry: telemetryStub(),
    localTools: null,
    model: "stub-model",
    systemPrompt: "You are a test agent.",
    enablePlanningMode: true
  });

  const result = await agent.runTurn("read src/index.js then explain the bug", {
    planning: true,
    onPlan: (plan) => plans.push(plan)
  });

  assert.equal(result.outputText, "Context received.");
  assert.equal(plans.length, 1);
  assert.equal(Array.isArray(plans[0].steps), true);
  assert.equal(plans[0].steps.length >= 2, true);
  assert.equal(result.plan?.status, "completed");
  assert.equal(
    provider.capturedMessages.some(
      (message) => message.role === "system" && String(message.content).startsWith("Execution plan (planning mode):")
    ),
    true
  );

  const noPlan = await agent.runTurn("just answer", { planning: false });
  assert.equal(noPlan.plan, null);
});

test("agent records prompt/tool contract versions in telemetry and model I/O logs", async () => {
  const provider = new ContextProbeProvider();
  const telemetry = telemetryStub();
  const modelIoLogger = modelIoLoggerStub();

  const agent = new StarcodeAgent({
    provider,
    telemetry,
    modelIoLogger,
    localTools: null,
    model: "stub-model",
    systemPrompt: "You are a test agent.",
    promptVersion: "v2",
    toolSchemaVersion: "v2"
  });

  const result = await agent.runTurn("hello");
  assert.equal(result.contractVersions.prompt, "v2");
  assert.equal(result.contractVersions.tool_schema, "v2");

  const conversationTurn = telemetry.state.conversationTurns[0];
  assert.equal(conversationTurn.contractVersions.prompt, "v2");
  assert.equal(conversationTurn.contractVersions.tool_schema, "v2");

  const behaviorTurn = telemetry.state.modelBehaviorEvents[0];
  assert.equal(behaviorTurn.contractVersions.prompt, "v2");
  assert.equal(behaviorTurn.contractVersions.tool_schema, "v2");

  const modelRequest = modelIoLogger.state.events.find((event) => event.phase === "model_request");
  assert.equal(modelRequest.prompt_version, "v2");
  assert.equal(modelRequest.tool_schema_version, "v2");
});
