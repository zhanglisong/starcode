import { randomUUID } from "node:crypto";
import { parseMcpToolName } from "../mcp/mcpManager.js";

function normalizeContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item?.type === "text" && typeof item?.text === "string") {
          return item.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (content === null || content === undefined) {
    return "";
  }

  return String(content);
}

function buildAssistantMessageFromResult(result, includeToolCalls = false) {
  const message = {
    role: "assistant",
    content: normalizeContent(result?.message?.content ?? result?.outputText)
  };

  if (result?.message?.reasoning_content !== undefined) {
    message.reasoning_content = result.message.reasoning_content;
  }

  if (includeToolCalls && result?.toolCalls?.length) {
    message.tool_calls = result.toolCalls;
  }

  return message;
}

function parseToolArguments(rawArguments) {
  if (typeof rawArguments !== "string") {
    return {};
  }

  try {
    return JSON.parse(rawArguments);
  } catch {
    return {
      _raw: rawArguments
    };
  }
}

function createLatencyBreakdown({
  totalMs,
  modelMs,
  toolMs,
  modelCalls,
  toolCalls,
  toolFailures,
  toolRounds
}) {
  const safeTotal = Number.isFinite(totalMs) ? Math.max(0, Math.round(totalMs)) : 0;
  const safeModelMs = Number.isFinite(modelMs) ? Math.max(0, Math.round(modelMs)) : 0;
  const safeToolMs = Number.isFinite(toolMs) ? Math.max(0, Math.round(toolMs)) : 0;
  const safeModelCalls = Number.isFinite(modelCalls) ? Math.max(0, modelCalls) : 0;
  const safeToolCalls = Number.isFinite(toolCalls) ? Math.max(0, toolCalls) : 0;
  const safeToolFailures = Number.isFinite(toolFailures) ? Math.max(0, toolFailures) : 0;
  const safeToolRounds = Number.isFinite(toolRounds) ? Math.max(0, toolRounds) : 0;
  const otherMs = Math.max(0, safeTotal - safeModelMs - safeToolMs);

  return {
    total_ms: safeTotal,
    model_ms: safeModelMs,
    tool_ms: safeToolMs,
    other_ms: otherMs,
    model_calls: safeModelCalls,
    tool_calls: safeToolCalls,
    tool_failures: safeToolFailures,
    tool_rounds: safeToolRounds,
    model_avg_ms: safeModelCalls ? Math.round(safeModelMs / safeModelCalls) : 0,
    tool_avg_ms: safeToolCalls ? Math.round(safeToolMs / safeToolCalls) : 0
  };
}

function stableStringify(value) {
  try {
    return JSON.stringify(value, Object.keys(value || {}).sort());
  } catch {
    return JSON.stringify(value);
  }
}

function toolShapeKey(toolName, parsedArguments) {
  return `${toolName}:${stableStringify(parsedArguments)}`;
}

function pushToolMessage(messages, toolCallId, payload) {
  messages.push({
    role: "tool",
    tool_call_id: toolCallId,
    content: JSON.stringify(payload)
  });
}

function truncateText(value, max = 220) {
  const normalized = normalizeContent(value).replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function isSessionSummaryMessage(message) {
  return message?.role === "system" && String(message?.content ?? "").startsWith("Session memory summary:");
}

function summarizeOlderMessages(messages) {
  const lines = [];
  for (const message of messages) {
    if (!message || isSessionSummaryMessage(message)) {
      continue;
    }
    if (!["user", "assistant", "tool"].includes(message.role)) {
      continue;
    }
    const text = truncateText(message.content, 180);
    if (!text) {
      continue;
    }
    lines.push(`- ${message.role}: ${text}`);
  }
  return lines.join("\n");
}

function isToolScaffoldMessage(message) {
  if (!message || typeof message !== "object") {
    return false;
  }

  if (message.role === "tool") {
    return true;
  }

  if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return true;
  }

  return false;
}

function buildExecutionPlan(userText) {
  const normalized = String(userText ?? "").trim();
  const splitCandidates = normalized
    .split(/\bthen\b|[.;]/gi)
    .map((part) => part.trim())
    .filter(Boolean);

  const candidateSteps = splitCandidates.length
    ? splitCandidates
    : [
        `Understand request: ${truncateText(normalized, 120)}`,
        "Inspect relevant files and current workspace state",
        "Implement and verify the requested change"
      ];

  const steps = candidateSteps.slice(0, 5).map((step, index) => ({
    id: `step_${index + 1}`,
    text: step,
    status: "pending"
  }));

  return {
    goal: normalized,
    steps,
    created_at: new Date().toISOString()
  };
}

function planToSystemPrompt(plan) {
  const steps = (plan?.steps ?? []).map((step, index) => `${index + 1}. ${step.text}`).join("\n");
  return [
    "Execution plan (planning mode):",
    `Goal: ${plan.goal}`,
    steps ? `Steps:\n${steps}` : "Steps:\n1. Execute the request safely and verify output.",
    "Follow this plan order, and report completion status for each step in your final response."
  ].join("\n");
}

function applyToolSchemaVersion(tools, version) {
  const schemaVersion = String(version ?? "v1");
  if (schemaVersion === "v1") {
    return tools;
  }

  return tools.map((tool) => {
    const fn = tool?.function ?? {};
    const baseDescription = String(fn.description ?? "").trim();
    const description = baseDescription.startsWith(`[schema:${schemaVersion}]`)
      ? baseDescription
      : `[schema:${schemaVersion}] ${baseDescription}`.trim();

    return {
      ...tool,
      function: {
        ...fn,
        description
      }
    };
  });
}

export class StarcodeAgent {
  constructor({
    provider,
    telemetry,
    modelIoLogger,
    gitContextProvider,
    mcpManager,
    permissionManager,
    localTools,
    model,
    systemPrompt,
    promptVersion = "v1",
    toolSchemaVersion = "v1",
    temperature = 0.2,
    topP = 1,
    maxTokens = 1024,
    maxToolRounds = 5,
    enableStreaming = false,
    enablePlanningMode = false,
    enableSessionSummary = false,
    sessionSummaryTriggerMessages = 18,
    sessionSummaryKeepRecent = 8
  }) {
    this.provider = provider;
    this.telemetry = telemetry;
    this.modelIoLogger = modelIoLogger;
    this.gitContextProvider = gitContextProvider;
    this.mcpManager = mcpManager;
    this.permissionManager = permissionManager;
    this.localTools = localTools;
    this.model = model;
    this.promptVersion = promptVersion;
    this.toolSchemaVersion = toolSchemaVersion;
    this.temperature = temperature;
    this.topP = topP;
    this.maxTokens = maxTokens;
    this.maxToolRounds = maxToolRounds;
    this.enableStreaming = enableStreaming;
    this.enablePlanningMode = enablePlanningMode;
    this.enableSessionSummary = enableSessionSummary;
    this.sessionSummaryTriggerMessages = sessionSummaryTriggerMessages;
    this.sessionSummaryKeepRecent = sessionSummaryKeepRecent;
    this.sessionSummary = "";
    this.messages = [{ role: "system", content: systemPrompt }];
  }

  exportSessionState() {
    return {
      messages: this.messages.map((message) => ({ ...message })),
      sessionSummary: this.sessionSummary
    };
  }

  hydrateSessionState({ messages, sessionSummary } = {}) {
    const list = Array.isArray(messages) ? messages.filter((item) => item && typeof item === "object") : [];
    if (list.length > 0) {
      this.messages = list.map((message) => ({ ...message }));
    }

    if (typeof sessionSummary === "string") {
      this.sessionSummary = sessionSummary;
    }
  }

  async logModelIo(event) {
    if (!this.modelIoLogger) {
      return;
    }
    await this.modelIoLogger.log(event);
  }

  compactSessionMemory() {
    if (!this.enableSessionSummary) {
      return null;
    }

    const systemPrompt = this.messages[0];
    const history = this.messages.slice(1).filter((message) => !isSessionSummaryMessage(message));
    const stableHistory = history.filter((message) => !isToolScaffoldMessage(message));
    const trigger = Math.max(1, Number(this.sessionSummaryTriggerMessages) || 18);
    const keepRecent = Math.max(1, Number(this.sessionSummaryKeepRecent) || 8);

    if (stableHistory.length <= trigger) {
      return null;
    }

    const splitIndex = Math.max(0, stableHistory.length - keepRecent);
    const older = stableHistory.slice(0, splitIndex);
    const recent = stableHistory.slice(splitIndex);
    const olderSummary = summarizeOlderMessages(older);

    if (!olderSummary) {
      return null;
    }

    const summaryParts = [];
    if (this.sessionSummary) {
      summaryParts.push(this.sessionSummary);
    }
    summaryParts.push(olderSummary);

    const mergedSummary = summaryParts.join("\n");
    const summaryLines = mergedSummary
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const boundedSummary = summaryLines.slice(Math.max(0, summaryLines.length - 60)).join("\n");

    this.sessionSummary = boundedSummary;
    this.messages = [
      systemPrompt,
      {
        role: "system",
        content: `Session memory summary:\n${this.sessionSummary}`
      },
      ...recent
    ];

    return {
      history_messages: stableHistory.length,
      compressed_messages: older.length,
      summary_lines: boundedSummary ? boundedSummary.split("\n").length : 0
    };
  }

  async runTurn(userText, options = {}) {
    const traceId = randomUUID();
    const baseMessageCount = this.messages.length;
    const turnMessages = [...this.messages];
    let gitContext = null;
    let contextMessageCount = 0;
    let mcpSnapshot = null;
    let persistedTurnMessages = false;

    if (this.gitContextProvider) {
      try {
        gitContext = await this.gitContextProvider.buildContext();
      } catch (error) {
        await this.logModelIo({
          phase: "git_context_error",
          trace_id: traceId,
          error: {
            name: error.name,
            message: error.message
          }
        });
      }
    }

    if (gitContext?.content) {
      turnMessages.push({
        role: "system",
        content: gitContext.content
      });
      contextMessageCount += 1;

      await this.logModelIo({
        phase: "git_context",
        trace_id: traceId,
        source: gitContext.source,
        branch: gitContext.branch,
        changed_files: gitContext.changed_files,
        truncated: gitContext.truncated
      });
    } else {
      await this.logModelIo({
        phase: "git_context",
        trace_id: traceId,
        source: "git",
        skipped: true
      });
    }

    if (this.mcpManager?.isEnabled?.()) {
      try {
        mcpSnapshot = await this.mcpManager.discover();
        await this.logModelIo({
          phase: "mcp_discovery",
          trace_id: traceId,
          servers: mcpSnapshot.servers?.map((server) => ({
            id: server.id,
            version: server.version,
            tools: server.tools?.length ?? 0,
            resources: server.resources?.length ?? 0,
            prompts: server.prompts?.length ?? 0
          })),
          errors: mcpSnapshot.errors ?? []
        });

        if (mcpSnapshot.contextText) {
          turnMessages.push({
            role: "system",
            content: mcpSnapshot.contextText
          });
          contextMessageCount += 1;
        }
      } catch (error) {
        await this.logModelIo({
          phase: "mcp_discovery_error",
          trace_id: traceId,
          error: {
            name: error.name,
            message: error.message
          }
        });
      }
    }

    const planningRequested = this.enablePlanningMode && options?.planning !== false;
    let activePlan = null;
    if (planningRequested) {
      activePlan = buildExecutionPlan(userText);
      turnMessages.push({
        role: "system",
        content: planToSystemPrompt(activePlan)
      });
      if (typeof options?.onPlan === "function") {
        options.onPlan(activePlan);
      }
      await this.logModelIo({
        phase: "plan_generated",
        trace_id: traceId,
        plan: activePlan
      });
    }

    const userMessage = { role: "user", content: userText };
    turnMessages.push(userMessage);

    const startedAt = Date.now();
    const streamRequested = this.enableStreaming && options?.stream === true;
    const onTextDelta = typeof options?.onTextDelta === "function" ? options.onTextDelta : null;
    const allToolCalls = [];
    const allToolResults = [];
    let latestUsage = {};
    let latestFinishReason = "unknown";
    let finalAssistantText = "";
    let summaryUpdate = null;
    const executedById = new Map();
    const timing = {
      modelMs: 0,
      toolMs: 0,
      modelCalls: 0,
      toolCalls: 0,
      toolFailures: 0,
      toolRounds: 0
    };

    const resolveSessionSummaryState = (currentUpdate) => {
      if (currentUpdate) {
        return currentUpdate;
      }
      if (!this.sessionSummary) {
        return null;
      }
      return {
        summary_lines: this.sessionSummary.split("\n").filter(Boolean).length,
        reused: true
      };
    };

    const persistTurnMessages = () => {
      if (persistedTurnMessages) {
        return;
      }
      const skipCount = baseMessageCount + contextMessageCount;
      const newMessages = turnMessages.slice(skipCount);
      if (newMessages.length) {
        this.messages.push(...newMessages);
      }
      persistedTurnMessages = true;
    };

    try {
      const rawLocalTools = this.localTools?.getToolDefinitions?.() ?? [];
      const rawMcpTools = mcpSnapshot?.toolDefinitions ?? [];
      const tools = applyToolSchemaVersion([...rawLocalTools, ...rawMcpTools], this.toolSchemaVersion);

      for (let round = 0; round <= this.maxToolRounds; round += 1) {
        await this.logModelIo({
          phase: "model_request",
          trace_id: traceId,
          round,
          model: this.model,
          prompt_version: this.promptVersion,
          tool_schema_version: this.toolSchemaVersion,
          stream_requested: streamRequested,
          messages: turnMessages,
          tools
        });

        const modelStartedAt = Date.now();
        let result;

        const invokeComplete = async ({ stream }) =>
          this.provider.complete({
            model: this.model,
            messages: turnMessages,
            temperature: this.temperature,
            topP: this.topP,
            maxTokens: this.maxTokens,
            tools,
            stream,
            onDelta: stream
              ? (delta) => {
                  if (delta?.type === "text" && typeof delta.text === "string" && onTextDelta) {
                    onTextDelta(delta.text);
                  }
                }
              : undefined
          });

        try {
          if (streamRequested) {
            try {
              result = await invokeComplete({ stream: true });
            } catch (error) {
              if (!error?.streamUnsupported) {
                throw error;
              }

              await this.logModelIo({
                phase: "stream_fallback",
                trace_id: traceId,
                round,
                reason: error.message
              });

              result = await invokeComplete({ stream: false });
            }
          } else {
            result = await invokeComplete({ stream: false });
          }
        } finally {
          timing.modelCalls += 1;
          timing.modelMs += Date.now() - modelStartedAt;
        }

        latestUsage = result.usage ?? latestUsage;
        latestFinishReason = result.finishReason ?? latestFinishReason;

        await this.logModelIo({
          phase: "model_response",
          trace_id: traceId,
          round,
          finish_reason: result.finishReason,
          usage: result.usage,
          message: result.message ?? {
            role: "assistant",
            content: normalizeContent(result.outputText)
          },
          tool_calls: result.toolCalls ?? [],
          stream_used: result?.raw?.streaming === true,
          model_latency_ms: Date.now() - modelStartedAt
        });

        if (!result.toolCalls?.length || (!this.localTools && !this.mcpManager)) {
          const assistantMessage = buildAssistantMessageFromResult(result, false);
          finalAssistantText = assistantMessage.content || "No response text returned.";
          if (!assistantMessage.content) {
            assistantMessage.content = finalAssistantText;
          }
          turnMessages.push(assistantMessage);
          break;
        }

        allToolCalls.push(...result.toolCalls);

        if (round === this.maxToolRounds) {
          latestFinishReason = "max_tool_rounds";
          finalAssistantText = "Tool-call round limit reached before final response.";
          turnMessages.push({ role: "assistant", content: finalAssistantText });
          break;
        }

        timing.toolRounds += 1;
        turnMessages.push(buildAssistantMessageFromResult(result, true));

        const executedByShapeInRound = new Map();

        for (const call of result.toolCalls) {
          const toolStartedAt = Date.now();
          const toolName = call?.function?.name ?? "unknown";
          const parsedArguments = parseToolArguments(call?.function?.arguments);
          const toolCallId = call?.id ?? `tool_${randomUUID()}`;
          const shapeKey = toolShapeKey(toolName, parsedArguments);
          const parsedMcp = parseMcpToolName(toolName);

          await this.logModelIo({
            phase: "tool_start",
            trace_id: traceId,
            round,
            tool_call_id: toolCallId,
            name: toolName,
            arguments: parsedArguments
          });

          const cachedById = call?.id ? executedById.get(call.id) : null;
          const cachedByShape = executedByShapeInRound.get(shapeKey);
          const cached = cachedById ?? cachedByShape;

          if (cached) {
            const reusedDurationMs = Date.now() - toolStartedAt;
            allToolResults.push({
              tool_call_id: toolCallId,
              name: toolName,
              arguments: parsedArguments,
              ok: cached.ok,
              result: cached.result,
              error: cached.error,
              duration_ms: reusedDurationMs,
              reused: true,
              duplicate_of: cached.tool_call_id,
              ...(cached.meta ?? {})
            });

            await this.logModelIo({
              phase: "tool_result",
              trace_id: traceId,
              round,
              tool_call_id: toolCallId,
              name: toolName,
              ok: cached.ok,
              result: cached.result,
              error: cached.error,
              duration_ms: reusedDurationMs,
              reused: true,
              duplicate_of: cached.tool_call_id,
              ...(cached.meta ?? {})
            });

            pushToolMessage(turnMessages, toolCallId, cached.tool_payload);
            continue;
          }

          let permissionDecision = null;
          if (this.permissionManager) {
            permissionDecision = await this.permissionManager.authorizeToolCall(call, {
              traceId,
              round,
              toolCallId
            });

            await this.logModelIo({
              phase: "permission_decision",
              trace_id: traceId,
              round,
              tool_call_id: toolCallId,
              tool_name: toolName,
              allowed: permissionDecision.allowed,
              decision: permissionDecision.decision,
              mode: permissionDecision.mode,
              source: permissionDecision.source,
              permission: permissionDecision.request?.permission ?? null,
              patterns: permissionDecision.request?.patterns ?? [],
              reason: permissionDecision.reason ?? null,
              denied_rule: permissionDecision.denied_rule ?? null,
              prompt_decision: permissionDecision.prompt_decision ?? null
            });
          }

          if (permissionDecision && !permissionDecision.allowed) {
            const toolDurationMs = Date.now() - toolStartedAt;
            timing.toolMs += toolDurationMs;
            timing.toolCalls += 1;
            timing.toolFailures += 1;

            const toolPayload = {
              ok: false,
              denied: true,
              error: "permission denied",
              permission: {
                decision: permissionDecision.decision,
                source: permissionDecision.source,
                mode: permissionDecision.mode,
                reason: permissionDecision.reason ?? null,
                request: permissionDecision.request,
                denied_rule: permissionDecision.denied_rule ?? null,
                prompt_decision: permissionDecision.prompt_decision ?? null
              }
            };

            const payload = {
              ok: false,
              result: null,
              error: "permission denied",
              tool_payload: toolPayload,
              tool_call_id: toolCallId,
              meta: null
            };

            allToolResults.push({
              tool_call_id: toolCallId,
              name: toolName,
              arguments: parsedArguments,
              ok: false,
              denied: true,
              error: "permission denied",
              duration_ms: toolDurationMs,
              permission: toolPayload.permission
            });

            await this.logModelIo({
              phase: "tool_result",
              trace_id: traceId,
              round,
              tool_call_id: toolCallId,
              name: toolName,
              ok: false,
              denied: true,
              error: "permission denied",
              duration_ms: toolDurationMs,
              permission: toolPayload.permission
            });

            if (call?.id) {
              executedById.set(call.id, payload);
            }
            executedByShapeInRound.set(shapeKey, payload);
            pushToolMessage(turnMessages, toolCallId, toolPayload);
            continue;
          }

          try {
            let toolResult;
            let toolMeta = null;

            if (parsedMcp && this.mcpManager) {
              const mcpExecution = await this.mcpManager.executeToolCall({
                ...call,
                id: toolCallId
              });
              toolResult = mcpExecution.result;
              toolMeta = mcpExecution.meta;
            } else if (this.localTools) {
              toolResult = await this.localTools.executeToolCall({
                ...call,
                id: toolCallId
              });
            } else {
              throw new Error(`No tool executor configured for ${toolName}`);
            }
            const toolDurationMs = Date.now() - toolStartedAt;
            timing.toolMs += toolDurationMs;
            timing.toolCalls += 1;

            const payload = {
              ok: true,
              result: toolResult,
              error: null,
              tool_payload: toolResult,
              tool_call_id: toolCallId,
              meta: toolMeta
            };

            allToolResults.push({
              tool_call_id: toolCallId,
              name: toolName,
              arguments: parsedArguments,
              ok: true,
              result: toolResult,
              duration_ms: toolDurationMs,
              permission: permissionDecision
                ? {
                    decision: permissionDecision.decision,
                    source: permissionDecision.source,
                    mode: permissionDecision.mode,
                    reason: permissionDecision.reason ?? null,
                    prompt_decision: permissionDecision.prompt_decision ?? null
                  }
                : null,
              ...(toolMeta ?? {})
            });

            await this.logModelIo({
              phase: "tool_result",
              trace_id: traceId,
              round,
              tool_call_id: toolCallId,
              name: toolName,
              ok: true,
              result: toolResult,
              duration_ms: toolDurationMs,
              permission: permissionDecision
                ? {
                    decision: permissionDecision.decision,
                    source: permissionDecision.source,
                    mode: permissionDecision.mode,
                    reason: permissionDecision.reason ?? null,
                    prompt_decision: permissionDecision.prompt_decision ?? null
                  }
                : null,
              ...(toolMeta ?? {})
            });

            if (call?.id) {
              executedById.set(call.id, payload);
            }
            executedByShapeInRound.set(shapeKey, payload);

            pushToolMessage(turnMessages, toolCallId, toolResult);
          } catch (error) {
            const toolDurationMs = Date.now() - toolStartedAt;
            timing.toolMs += toolDurationMs;
            timing.toolCalls += 1;
            timing.toolFailures += 1;

            const toolPayload = {
              ok: false,
              error: error.message
            };

            const payload = {
              ok: false,
              result: null,
              error: error.message,
              tool_payload: toolPayload,
              tool_call_id: toolCallId,
              meta: parsedMcp
                ? {
                    mcp_server_id: parsedMcp.serverId,
                    mcp_tool_name: parsedMcp.toolName
                  }
                : null
            };

            allToolResults.push({
              tool_call_id: toolCallId,
              name: toolName,
              arguments: parsedArguments,
              ok: false,
              error: error.message,
              duration_ms: toolDurationMs,
              permission: permissionDecision
                ? {
                    decision: permissionDecision.decision,
                    source: permissionDecision.source,
                    mode: permissionDecision.mode,
                    reason: permissionDecision.reason ?? null,
                    prompt_decision: permissionDecision.prompt_decision ?? null
                  }
                : null,
              ...(payload.meta ?? {})
            });

            await this.logModelIo({
              phase: "tool_result",
              trace_id: traceId,
              round,
              tool_call_id: toolCallId,
              name: toolName,
              ok: false,
              error: error.message,
              duration_ms: toolDurationMs,
              permission: permissionDecision
                ? {
                    decision: permissionDecision.decision,
                    source: permissionDecision.source,
                    mode: permissionDecision.mode,
                    reason: permissionDecision.reason ?? null,
                    prompt_decision: permissionDecision.prompt_decision ?? null
                  }
                : null,
              ...(payload.meta ?? {})
            });

            if (call?.id) {
              executedById.set(call.id, payload);
            }
            executedByShapeInRound.set(shapeKey, payload);

            pushToolMessage(turnMessages, toolCallId, toolPayload);
          }
        }
      }

      persistTurnMessages();
      summaryUpdate = this.compactSessionMemory();
      if (summaryUpdate) {
        await this.logModelIo({
          phase: "session_summary_update",
          trace_id: traceId,
          ...summaryUpdate
        });
      }
      const sessionSummaryState = resolveSessionSummaryState(summaryUpdate);

      if (activePlan) {
        activePlan = {
          ...activePlan,
          status: "completed",
          completed_at: new Date().toISOString(),
          steps: activePlan.steps.map((step) => ({
            ...step,
            status: "completed"
          }))
        };
      }

      const latencyMs = Date.now() - startedAt;
      const latencyBreakdown = createLatencyBreakdown({
        totalMs: latencyMs,
        modelMs: timing.modelMs,
        toolMs: timing.toolMs,
        modelCalls: timing.modelCalls,
        toolCalls: timing.toolCalls,
        toolFailures: timing.toolFailures,
        toolRounds: timing.toolRounds
      });
      const assistantMessage = { role: "assistant", content: finalAssistantText };

      await this.telemetry.captureConversationTurn({
        traceId,
        request: userMessage,
        response: assistantMessage,
        model: this.model,
        tools: allToolCalls,
        toolResults: allToolResults,
        usage: latestUsage,
        latencyMs,
        latencyBreakdown,
        status: "ok",
        plan: activePlan,
        contractVersions: {
          prompt: this.promptVersion,
          tool_schema: this.toolSchemaVersion
        },
        sessionSummary: sessionSummaryState
      });

      await this.telemetry.captureModelBehavior({
        traceId,
        provider: this.provider.providerName,
        model: this.model,
        parameters: {
          temperature: this.temperature,
          top_p: this.topP,
          max_tokens: this.maxTokens
        },
        finishReason: latestFinishReason,
        safety: {
          reviewed_input: true,
          reviewed_output: true
        },
        toolDecisions: allToolCalls,
        toolResults: allToolResults,
        reasoningSummary: "Behavior data captured from runtime instrumentation.",
        sessionSummary: sessionSummaryState,
        plan: activePlan,
        contractVersions: {
          prompt: this.promptVersion,
          tool_schema: this.toolSchemaVersion
        },
        usage: latestUsage,
        latencyMs,
        latencyBreakdown
      });

      const flush = await this.telemetry.flush();

      await this.logModelIo({
        phase: "turn_end",
        trace_id: traceId,
        output_text: finalAssistantText,
        prompt_version: this.promptVersion,
        tool_schema_version: this.toolSchemaVersion,
        latency_ms: latencyMs,
        usage: latestUsage,
        latency_breakdown: latencyBreakdown,
        session_summary: sessionSummaryState,
        plan: activePlan
      });

      return {
        traceId,
        status: "ok",
        outputText: finalAssistantText,
        usage: latestUsage,
        latencyMs,
        latencyBreakdown,
        toolCalls: allToolCalls,
        toolResults: allToolResults,
        plan: activePlan,
        contractVersions: {
          prompt: this.promptVersion,
          tool_schema: this.toolSchemaVersion
        },
        sessionSummary: sessionSummaryState,
        flush
      };
    } catch (error) {
      persistTurnMessages();
      summaryUpdate = this.compactSessionMemory();
      if (summaryUpdate) {
        await this.logModelIo({
          phase: "session_summary_update",
          trace_id: traceId,
          ...summaryUpdate
        });
      }
      const sessionSummaryState = resolveSessionSummaryState(summaryUpdate);

      if (activePlan) {
        activePlan = {
          ...activePlan,
          status: "failed",
          failed_at: new Date().toISOString(),
          steps: activePlan.steps.map((step) => ({
            ...step,
            status: "incomplete"
          }))
        };
      }

      const latencyMs = Date.now() - startedAt;
      const latencyBreakdown = createLatencyBreakdown({
        totalMs: latencyMs,
        modelMs: timing.modelMs,
        toolMs: timing.toolMs,
        modelCalls: timing.modelCalls,
        toolCalls: timing.toolCalls,
        toolFailures: timing.toolFailures,
        toolRounds: timing.toolRounds
      });

      await this.logModelIo({
        phase: "turn_error",
        trace_id: traceId,
        latency_ms: latencyMs,
        latency_breakdown: latencyBreakdown,
        error: {
          name: error.name,
          message: error.message
        }
      });

      await this.telemetry.captureModelBehavior({
        traceId,
        provider: this.provider.providerName,
        model: this.model,
        parameters: {
          temperature: this.temperature,
          top_p: this.topP,
          max_tokens: this.maxTokens
        },
        error: {
          name: error.name,
          message: error.message
        },
        plan: activePlan,
        contractVersions: {
          prompt: this.promptVersion,
          tool_schema: this.toolSchemaVersion
        },
        sessionSummary: sessionSummaryState,
        latencyMs,
        latencyBreakdown
      });

      await this.telemetry.flush();
      throw error;
    }
  }
}
