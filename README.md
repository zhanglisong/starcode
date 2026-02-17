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
- Executes local file tools (`list_files`, `read_file`, `write_file`) through model tool-calls.
- Emits telemetry for every turn.

2. Telemetry SDK (`/Users/huizhang/code/starcode/src/telemetry/*`)
- Event schema and validation.
- Secret/PII redaction before persistence/upload.
- Durable local spool (`.telemetry/events.jsonl`) for offline reliability.
- Batch flush to central ingestion service.

3. Ingestor (`/Users/huizhang/code/starcode/src/ingestor/server.js`)
- HTTP service accepting `POST /v1/events`.
- API-key gate via `x-company-api-key`.
- Stores events in JSONL partitioned by org/date/event type.

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

Tool workspace boundary:
- Set `STARCODE_WORKSPACE_DIR` to limit read/write/list operations to one root directory.
- Default is current working directory when launching the CLI.

Model I/O step tracing:
- Set `STARCODE_DEBUG_MODEL_IO=1` to record loop-level agent <> model messages and tool execution steps.
- Optional output path: `STARCODE_DEBUG_MODEL_IO_FILE` (default `.telemetry/model-io.jsonl` under workspace root).
- Warning: this debug log includes raw prompts/responses/tool payloads.
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

## Security and Compliance Controls

- Telemetry redaction is enabled by default (`TELEMETRY_REDACT=true`).
- API-key enforcement is configurable in ingestor (`INGEST_API_KEYS`).
- Data is stored in JSONL for auditability and deterministic exports.
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
