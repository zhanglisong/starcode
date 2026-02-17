#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

function parseJsonl(raw) {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function findLatestTraceId(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const traceId = events[i]?.trace_id;
    if (traceId) {
      return traceId;
    }
  }
  return "";
}

function toJsonBlock(value) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function buildTimeline(events) {
  const lines = [
    "| ts | phase | round | tool | status | finish_reason |",
    "| --- | --- | ---: | --- | --- | --- |"
  ];

  for (const event of events) {
    const tool = event.name ?? event.tool_call_id ?? "-";
    const status = event.ok === undefined ? "-" : String(event.ok);
    const finish = event.finish_reason ?? "-";
    lines.push(`| ${event.ts ?? "-"} | ${event.phase ?? "-"} | ${event.round ?? "-"} | ${tool} | ${status} | ${finish} |`);
  }

  return lines.join("\n");
}

function uniqueRounds(events) {
  const set = new Set();
  for (const event of events) {
    if (typeof event.round === "number") {
      set.add(event.round);
    }
  }
  return [...set].sort((a, b) => a - b);
}

function eventsForRound(events, round) {
  return events.filter((event) => event.round === round);
}

function requestForRound(events, round) {
  return events.find((event) => event.phase === "model_request" && event.round === round);
}

function responseForRound(events, round) {
  return events.find((event) => event.phase === "model_response" && event.round === round);
}

function buildRoundSection(events, round) {
  const req = requestForRound(events, round);
  const res = responseForRound(events, round);
  const toolEvents = eventsForRound(events, round).filter(
    (event) => event.phase === "tool_start" || event.phase === "tool_result"
  );

  const sections = [`## Round ${round}`];

  if (req) {
    sections.push("### Agent -> Model (request)");
    sections.push(toJsonBlock({
      model: req.model,
      messages: req.messages,
      tools: req.tools
    }));
  } else {
    sections.push("### Agent -> Model (request)");
    sections.push("(no request event found)");
  }

  if (res) {
    sections.push("### Model -> Agent (response)");
    sections.push(toJsonBlock({
      finish_reason: res.finish_reason,
      usage: res.usage,
      message: res.message,
      tool_calls: res.tool_calls
    }));
  } else {
    sections.push("### Model -> Agent (response)");
    sections.push("(no response event found)");
  }

  if (toolEvents.length > 0) {
    sections.push("### Tool Events");
    sections.push(toJsonBlock(toolEvents.map((event) => ({
      ts: event.ts,
      phase: event.phase,
      tool_call_id: event.tool_call_id,
      name: event.name,
      arguments: event.arguments,
      ok: event.ok,
      result: event.result,
      error: event.error,
      duration_ms: event.duration_ms
    }))));
  }

  return sections.join("\n\n");
}

async function main() {
  const cwd = process.cwd();
  const inputPathRaw = process.env.STARCODE_MODEL_IO_INPUT ?? ".telemetry/model-io.jsonl";
  const outputPathRaw = process.env.STARCODE_MODEL_IO_OUTPUT ?? "tmp/round-transcript.md";
  const requestedTraceId = process.env.TRACE_ID ?? "";

  const inputPath = path.isAbsolute(inputPathRaw) ? inputPathRaw : path.resolve(cwd, inputPathRaw);
  const outputPath = path.isAbsolute(outputPathRaw) ? outputPathRaw : path.resolve(cwd, outputPathRaw);

  const raw = await fs.readFile(inputPath, "utf8");
  const allEvents = parseJsonl(raw);

  if (allEvents.length === 0) {
    throw new Error(`No events found in ${inputPath}`);
  }

  const traceId = requestedTraceId || findLatestTraceId(allEvents);
  if (!traceId) {
    throw new Error("Could not resolve trace_id");
  }

  const events = allEvents.filter((event) => event.trace_id === traceId);
  if (events.length === 0) {
    throw new Error(`No events found for trace_id=${traceId}`);
  }

  const rounds = uniqueRounds(events);
  const turnEnd = events.find((event) => event.phase === "turn_end");

  const doc = [
    `# Model I/O Round Transcript`,
    "",
    `- trace_id: \`${traceId}\``,
    `- source: \`${inputPath}\``,
    `- generated_at: \`${new Date().toISOString()}\``,
    "",
    "## Timeline",
    "",
    buildTimeline(events),
    "",
    ...rounds.map((round) => buildRoundSection(events, round)),
    "",
    "## Turn End",
    "",
    turnEnd ? toJsonBlock(turnEnd) : "(no turn_end event found)",
    ""
  ].join("\n");

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, doc, "utf8");

  process.stdout.write(`Transcript generated\n`);
  process.stdout.write(`trace_id=${traceId}\n`);
  process.stdout.write(`output=${outputPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
