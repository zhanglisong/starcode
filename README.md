# Starcode

A new starcode-style coding agent with enterprise telemetry.

This implementation captures:
- conversation records (`conversation.turn`)
- model behavior traces (`model.behavior`)
- model failures (`model.error`)
- session metadata (`session.meta`)
- tool execution outcomes (`tool_results` in telemetry payloads)

It supports company-wide aggregation across many engineers and exports post-training datasets.

## Architecture

1. Agent CLI (`/Users/huizhang/code/starcode/src/cli/starcode.js`)
- Interactive coding agent runtime.
- Uses provider abstraction (`mock` or OpenAI-compatible).
- Executes local workspace tools through model tool-calls (`list_files`, `glob_files`, `grep_files`, `read_file`, `write_file`, `create_file`, `edit_file`, `replace_in_file`, `insert_in_file`, `patch_file`, `move_file`, `delete_file`, `search_web`, `execute_shell`).
- Injects bounded git workspace context (`status`, changed files, diff stat) into model turns when enabled.
- Emits telemetry for every turn.

2. Telemetry SDK (`/Users/huizhang/code/starcode/src/telemetry/*`)
- Event schema and validation.
- Secret/PII redaction before persistence/upload.
- Durable local spool (`.telemetry/events.jsonl`) for offline reliability.
- Batch flush to central ingestion service.
- Retry with exponential backoff for temporary outages (events stay queued until successful delivery).
- Delivery metrics exposed on flush (`queued`, `sent`, `failed`).

3. Ingestor (`/Users/huizhang/code/starcode/src/ingestor/server.js`)
- HTTP service accepting `POST /v1/events`.
- API-key gate via `x-company-api-key`.
- Stores events in JSONL partitioned by org/date/event type.
- Idempotent ingest via persisted `event_id` index (duplicate event posts are deduplicated).
- `GET /health` exposes total event count plus org/team/engineer aggregation summary.
- Governance APIs: `POST /v1/admin/delete` (delete by `org_id`/`engineer_id`/`trace_id`) and `POST /v1/admin/retention/apply`.

4. Training Export (`/Users/huizhang/code/starcode/src/training/exportDataset.js`)
- Builds SFT rows from conversation events.
- Builds behavior/error rows for model behavior tuning and analysis.
- Supports org filtering via `TRAINING_ORG_ID`.
- Writes export bundles with manifest.

## Quick Start

1) Configure

Set environment values from `/Users/huizhang/code/starcode/config/.env.example`.

2) Start ingestor

```bash
node /Users/huizhang/code/starcode/src/ingestor/server.js
```

3) Start agent

```bash
node /Users/huizhang/code/starcode/src/cli/starcode.js
```

Provider/auth UX commands (SC-023):
- `starcode auth login <provider> [--api-key <key>] [--endpoint <url>] [--model <id>]`
- `starcode auth logout [provider|--all]`
- `starcode auth list`
- `starcode models list [provider] [--endpoint <url>] [--api-key <key>]`
- `starcode models use <model_id> [--provider <provider>]`
- Stored profiles default to `~/.starcode/profiles.json` with restrictive permissions (`0700` dir, `0600` file).
- Override profile path with `STARCODE_PROFILE_PATH`.

MCP server lifecycle commands (SC-020):
- `starcode mcp list`
- `starcode mcp add <id> --endpoint <url> [--type http] [--api-key <key>] [--api-key-env <ENV>] [--header Key:Value]`
- `starcode mcp remove <id>`
- `starcode mcp enable <id>`
- `starcode mcp disable <id>`

MCP runtime behavior:
- Enabled MCP servers are discovered at runtime (tools/resources/prompts) and injected into agent context.
- MCP tools are exposed to the model as namespaced tools (`mcp__<server_id>__<tool_name>`).
- Per-server failures are isolated; one failing MCP server does not crash the main turn loop.
- MCP tool execution metadata (`mcp_server_id`, `mcp_server_version`, `mcp_tool_name`) is captured in tool telemetry.

Slash workflow commands (SC-017):
- `/fix <issue>`: deterministic fix workflow (inspect, patch, verify, summarize).
- `/test [command]`: deterministic test workflow (default `npm test`).
- `/explain <target>`: deterministic explanation workflow with file-backed context.
- `/commit [message]`: deterministic commit workflow; without a message, Starcode proposes one and stops.
- `/help`: show available slash commands.

Optional planner mode (SC-008):
- Enable with `STARCODE_ENABLE_PLANNING_MODE=true`.
- Starcode emits an actionable step plan before execution for each turn.
- Disable to skip planning and execute directly.

Prompt/tool contract versioning (SC-009):
- Set `STARCODE_PROMPT_VERSION` (`v1` or `v2`) to select prompt contract.
- Set `STARCODE_TOOL_SCHEMA_VERSION` (`v1` or `v2`) to select tool-schema contract.
- Override prompts with `SYSTEM_PROMPT` or `SYSTEM_PROMPT_V2`.
- Prompt/schema versions are recorded in model I/O logs and telemetry per trace.

Tool workspace boundary:
- Set `STARCODE_WORKSPACE_DIR` to limit read/write/list operations to one root directory.
- Default is current working directory when launching the CLI.
- Shell tool safety controls are configurable via:
  - `STARCODE_ENABLE_SHELL_TOOL`
  - `STARCODE_SHELL_TIMEOUT_MS`
  - `STARCODE_SHELL_MAX_TIMEOUT_MS`
  - `STARCODE_SHELL_MAX_OUTPUT_BYTES`
  - `STARCODE_SHELL_ALLOW_COMMANDS`
  - `STARCODE_SHELL_DENY_PATTERNS`
- Web search tool controls are configurable via:
  - `STARCODE_ENABLE_WEB_SEARCH_TOOL`
  - `STARCODE_WEB_SEARCH_PROVIDER`
  - `STARCODE_WEB_SEARCH_ENDPOINT`
  - `STARCODE_WEB_SEARCH_API_KEY`
  - `STARCODE_WEB_SEARCH_TIMEOUT_MS`
  - `STARCODE_WEB_SEARCH_MAX_RESULTS`
- Git context controls are configurable via:
  - `STARCODE_ENABLE_GIT_CONTEXT`
  - `STARCODE_GIT_CONTEXT_TIMEOUT_MS`
  - `STARCODE_GIT_CONTEXT_MAX_CHARS`
  - `STARCODE_GIT_CONTEXT_MAX_CHANGED_FILES`
  - `STARCODE_GIT_CONTEXT_MAX_STATUS_LINES`
- Streaming output is enabled by default (`STARCODE_ENABLE_STREAMING=true`).
  - If provider streaming is unsupported, Starcode falls back to non-streaming automatically.
- Session memory summary is enabled by default (`STARCODE_ENABLE_SESSION_SUMMARY=true`).
  - Older turns are auto-summarized after `STARCODE_SESSION_SUMMARY_TRIGGER_MESSAGES`.
  - Recent turns kept verbatim: `STARCODE_SESSION_SUMMARY_KEEP_RECENT`.

Model I/O step tracing:
- Set `STARCODE_DEBUG_MODEL_IO=1` to record loop-level agent <> model messages and tool execution steps.
- Optional output path: `STARCODE_DEBUG_MODEL_IO_FILE` (default `.telemetry/model-io.jsonl` under workspace root).
- Warning: this debug log includes raw prompts/responses/tool payloads.
- Inspect traces with filters:
  - `npm run debug:model-io -- --trace-id <trace_id> --round 0 --phase model_request,model_response`
  - `npm run debug:model-io -- --format jsonl --limit 20`
- Export round-by-round markdown transcript:
  - `npm run export:model-io`
  - Optional env: `TRACE_ID=<trace_id> STARCODE_MODEL_IO_INPUT=<path> STARCODE_MODEL_IO_OUTPUT=<path>`

4) Export post-training datasets

```bash
node /Users/huizhang/code/starcode/src/training/exportDataset.js
```

Outputs:
- `data/training/<timestamp>/sft.jsonl`
- `data/training/<timestamp>/behavior.jsonl`
- `data/training/<timestamp>/manifest.json`
- `data/training/<timestamp>/redaction-coverage.json`
- `sft.jsonl` and `behavior.jsonl` include `quality` flags and tool trace metadata for post-training filtering.
- `manifest.json` includes malformed-row/drop counters (`malformed_rows`, `dropped_sft`, `dropped_behavior`).

## Security and Compliance Controls

- Telemetry redaction is enabled by default (`TELEMETRY_REDACT=true`).
- Retry/backoff settings are configurable via `TELEMETRY_RETRY_BASE_MS`, `TELEMETRY_RETRY_MAX_MS`, `TELEMETRY_RETRY_MULTIPLIER`.
- API-key enforcement is configurable in ingestor (`INGEST_API_KEYS`).
- Org opt-in and retention are configurable via `INGEST_OPT_IN_ORGS` and `INGEST_RETENTION_DAYS`.
- Data is stored in JSONL for auditability and deterministic exports.
- Training export redaction is enabled by default (`TRAINING_REDACT=true`) with per-run coverage report.
- Add your own legal/compliance policy gates before using export data for post-training.

## Tests

```bash
node --test
```

## Suggested Production Hardening

1. Add mTLS between agent and ingestor.
2. Encrypt telemetry at rest.
3. Add RBAC and immutable audit logs for dataset exports.
4. Add policy filters and review workflow before training jobs.

## Eval-Lite Baseline (Step 1)

Use eval-lite to capture a baseline pass rate/latency before new parity work.

Run with current defaults (mock provider):

```bash
npm run eval:lite
```

Run with a real provider (example OpenAI-compatible endpoint):

```bash
MODEL_PROVIDER=openai-compatible \
MODEL_ENDPOINT=https://api.moonshot.ai/v1/chat/completions \
MODEL_API_KEY=$KIMI_API_KEY \
MODEL_NAME=kimi-k2.5 \
MODEL_TEMPERATURE=1 \
MODEL_TOP_P=0.95 \
npm run eval:lite
```

Outputs:
- JSON report: `tmp/eval-lite/reports/<run-id>.json`
- Markdown summary: `tmp/eval-lite/reports/<run-id>.md`
- Nightly history: `tmp/eval-lite/history/nightly.jsonl`
- Nightly summary: `tmp/eval-lite/history/nightly-summary.md`

Current eval-lite scope:
- 14 objective tasks across categories: `coding`, `edit`, `bugfix`, `shell`.
- Scoring checks: file state/content, response keywords, tool usage, and minimum tool-call count.
- Latency breakdown summary: model time vs tool time vs other overhead.
- Optional category filter: `STARCODE_EVAL_CATEGORIES=coding,bugfix`
- Optional history toggle: `STARCODE_EVAL_WRITE_HISTORY=false`

## Real-Model Regression Suite

Run expanded real-model regressions (beyond eval-lite) against current provider/model:

```bash
npm run eval:real-model
```

Optional filters:
- `STARCODE_REAL_EVAL_CATEGORIES=streaming,planning,memory`
- `STARCODE_REAL_EVAL_DIR=tmp/real-model-regression`

Coverage focus includes:
- streaming behavior, planning mode, session summary compaction
- prompt/tool contract version tagging
- recovery behavior, safety boundaries, and advanced file/shell flows

Outputs:
- JSON report: `tmp/real-model-regression/reports/<run-id>.json`
- Markdown report: `tmp/real-model-regression/reports/<run-id>.md`

## Provider Profiles (SC-001)

`MODEL_PROVIDER` controls default endpoint/auth behavior and compatibility constraints:

- `moonshot`
  - Default endpoint: `https://api.moonshot.ai/v1/chat/completions`
  - For `MODEL_NAME=kimi-k2.5`, Starcode auto-forces:
    - `temperature=1`
    - `top_p=0.95`
- `ollama`
  - Default endpoint: `http://127.0.0.1:11434/v1/chat/completions`
  - Authorization header is omitted by default.
  - `MODEL_API_KEY` is optional.
- `openai-compatible` (or `openai`)
  - Default endpoint: `https://api.openai.com/v1/chat/completions`
  - Uses passed sampling params directly.

You can always override endpoint with `MODEL_ENDPOINT`.

## Release Gate (SC-018)

After running eval-lite, enforce KPI thresholds:

```bash
npm run eval:gate
```

Default scorecard outputs:
- `tmp/eval-lite/scorecards/latest.scorecard.json`
- `tmp/eval-lite/scorecards/latest.scorecard.md`

Gate thresholds are configurable via:
- `STARCODE_GATE_MIN_TASK_SUCCESS_PCT`
- `STARCODE_GATE_MIN_TOOL_SUCCESS_PCT`
- `STARCODE_GATE_MAX_TASK_FAILURE_PCT`
- `STARCODE_GATE_MAX_TOOL_FAILURE_PCT`
- `STARCODE_GATE_MAX_LATENCY_P95_MS`

If any threshold fails, `eval:gate` exits non-zero for CI release blocking.
