const WORKFLOW_PREFIX = "Workflow";

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function quoteForSingleLine(value) {
  return String(value ?? "").replace(/\r?\n/g, " ").trim();
}

function buildFixPrompt(args) {
  const objective = hasText(args)
    ? `User issue to fix: ${quoteForSingleLine(args)}`
    : "User issue to fix: infer from git context, latest failures, and user intent in this session.";

  return [
    `${WORKFLOW_PREFIX}: /fix`,
    objective,
    "Execution steps (follow in order):",
    "1. Inspect repository state and relevant files first.",
    "2. Identify the root cause before making edits.",
    "3. Apply the minimal safe code changes needed to fix the issue.",
    "4. Run the smallest relevant verification (tests/lint/build) using tools.",
    "5. Return: root cause, files changed, verification results, and remaining risks."
  ].join("\n");
}

function buildTestPrompt(args) {
  const command = hasText(args) ? quoteForSingleLine(args) : "npm test";

  return [
    `${WORKFLOW_PREFIX}: /test`,
    `Primary test command: ${command}`,
    "Execution steps (follow in order):",
    "1. Run the test command using execute_shell.",
    "2. If tests fail, summarize failing tests and likely root causes.",
    "3. Do not modify files unless the user explicitly asks for fixes.",
    "4. Return: command, exit code, failing targets, and next recommendation."
  ].join("\n");
}

function buildExplainPrompt(args) {
  const target = hasText(args)
    ? quoteForSingleLine(args)
    : "(no explicit target provided)";

  return [
    `${WORKFLOW_PREFIX}: /explain`,
    `Explain target: ${target}`,
    "Execution steps (follow in order):",
    "1. Read the relevant files/symbols with tools before explaining.",
    "2. Explain behavior in plain language with concrete file references.",
    "3. Include control flow, important dependencies, and key edge cases.",
    "4. If target is missing/ambiguous, ask one concise clarifying question."
  ].join("\n");
}

function buildCommitPrompt(args) {
  const commitMessage = hasText(args) ? quoteForSingleLine(args) : "";

  return [
    `${WORKFLOW_PREFIX}: /commit`,
    commitMessage ? `Requested commit message: ${commitMessage}` : "Requested commit message: (none provided)",
    "Execution steps (follow in order):",
    "1. Inspect git status/diff to confirm what changed.",
    "2. If no commit message is provided, propose one and stop without committing.",
    "3. If a commit message is provided, stage intended files and create the commit.",
    "4. Return: final message, commit hash (if created), and file summary."
  ].join("\n");
}

const COMMAND_DEFINITIONS = {
  fix: {
    description: "Debug and apply a minimal fix with verification.",
    buildPrompt: buildFixPrompt
  },
  test: {
    description: "Run tests and summarize failures deterministically.",
    buildPrompt: buildTestPrompt
  },
  explain: {
    description: "Explain files/symbols with concrete references.",
    buildPrompt: buildExplainPrompt
  },
  commit: {
    description: "Prepare or create a commit with explicit commit message handling.",
    buildPrompt: buildCommitPrompt
  }
};

export function parseSlashCommand(input) {
  if (!hasText(input)) {
    return null;
  }

  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const [rawCommand, ...rest] = trimmed.split(/\s+/);
  const command = rawCommand.slice(1).toLowerCase();
  const args = rest.join(" ").trim();

  if (!command) {
    return {
      kind: "unknown",
      command,
      args
    };
  }

  if (command === "help") {
    return {
      kind: "help",
      command,
      args
    };
  }

  const definition = COMMAND_DEFINITIONS[command];
  if (!definition) {
    return {
      kind: "unknown",
      command,
      args
    };
  }

  return {
    kind: "command",
    command,
    args,
    prompt: definition.buildPrompt(args)
  };
}

export function renderSlashHelpText() {
  const rows = Object.entries(COMMAND_DEFINITIONS)
    .map(([command, definition]) => `/${command} - ${definition.description}`)
    .join("\n");
  return [`Available slash commands:`, rows, `/help - Show this command list.`].join("\n");
}
