import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { applyUpdateChunksToLines, parseApplyPatchText } from "./patchParser.js";

const DEFAULT_SHELL_ALLOW_COMMANDS = [
  "cat",
  "cd",
  "cp",
  "curl",
  "echo",
  "find",
  "git",
  "head",
  "jq",
  "ls",
  "mkdir",
  "mv",
  "node",
  "npm",
  "pwd",
  "rg",
  "sed",
  "tail",
  "touch",
  "wc"
];

const DEFAULT_SHELL_DENY_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bsudo\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bmkfs\b/i,
  /\bdd\b/i
];

const DEFAULT_WEB_SEARCH_TIMEOUT_MS = 8_000;
const DEFAULT_WEB_SEARCH_MAX_RESULTS = 8;
const DEFAULT_WEB_FETCH_TIMEOUT_MS = 12_000;
const DEFAULT_WEB_FETCH_MAX_BYTES = 300_000;
const DEFAULT_CODE_SEARCH_MAX_MATCHES = 120;

const DEFAULT_SYMBOL_PATTERNS = [
  {
    kind: "function",
    regex: /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g
  },
  {
    kind: "class",
    regex: /\bclass\s+([A-Za-z_$][\w$]*)\b/g
  },
  {
    kind: "interface",
    regex: /\binterface\s+([A-Za-z_$][\w$]*)\b/g
  },
  {
    kind: "type",
    regex: /\btype\s+([A-Za-z_$][\w$]*)\b/g
  },
  {
    kind: "const",
    regex: /\bconst\s+([A-Za-z_$][\w$]*)\s*=/g
  }
];

function safeJsonParse(raw) {
  if (typeof raw !== "string") {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function normalizePath(value) {
  if (!value || typeof value !== "string") {
    return ".";
  }
  return value;
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function parseMaxToolRounds(value, fallback = Infinity) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return fallback;
    }
    if (normalized === "infinity" || normalized === "inf" || normalized === "unlimited") {
      return Infinity;
    }
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(1, Math.round(parsed));
}

function appendBufferChunk(state, chunk, maxBytes) {
  if (!Buffer.isBuffer(chunk)) {
    return;
  }

  const remaining = maxBytes - state.bytes;
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }

  if (chunk.length <= remaining) {
    state.chunks.push(chunk);
    state.bytes += chunk.length;
    return;
  }

  state.chunks.push(chunk.subarray(0, remaining));
  state.bytes += remaining;
  state.truncated = true;
}

function extractExecutable(command) {
  const match = String(command ?? "").trim().match(/^['"]?([^'"\s]+)/);
  if (!match) {
    return "";
  }
  return path.basename(match[1]);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toPosixPath(value) {
  return String(value).split(path.sep).join("/");
}

function normalizeDomainList(input) {
  const values = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : [];

  return values
    .map((value) => String(value).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean);
}

function hostMatchesDomains(urlValue, domains) {
  if (!domains.length) {
    return true;
  }

  let host = "";
  try {
    host = new URL(String(urlValue)).hostname.toLowerCase();
  } catch {
    return false;
  }

  return domains.some((domain) => host === domain || host.endsWith("." + domain));
}

function flattenDuckDuckGoTopics(items, output) {
  for (const item of items || []) {
    if (Array.isArray(item?.Topics)) {
      flattenDuckDuckGoTopics(item.Topics, output);
      continue;
    }

    if (!item?.FirstURL || !item?.Text) {
      continue;
    }

    const text = String(item.Text);
    const [titleCandidate, snippetCandidate] = text.split(" - ");
    output.push({
      title: String(titleCandidate || "Untitled").trim(),
      url: String(item.FirstURL),
      snippet: String(snippetCandidate || text).trim(),
      source: "duckduckgo"
    });
  }
}

function normalizeSearchResultItem(item, fallbackSource) {
  const title = String(item?.title ?? item?.name ?? "Untitled").trim();
  const url = String(item?.url ?? item?.link ?? "").trim();

  if (!url) {
    return null;
  }

  const snippet = String(item?.snippet ?? item?.description ?? item?.text ?? "").trim();
  const source = String(item?.source ?? fallbackSource ?? "web").trim();

  return { title, url, snippet, source };
}

function withTimeoutAbort(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer)
  };
}

function stripHtml(value) {
  return String(value ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/?(p|div|section|article|header|footer|main|aside|li|ul|ol|h1|h2|h3|h4|h5|h6|pre|br)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractLinksFromHtml(html, max = 80) {
  const links = [];
  const seen = new Set();
  const text = String(html ?? "");
  const regex = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = regex.exec(text)) && links.length < max) {
    const href = String(match[1] ?? "").trim();
    if (!href || seen.has(href)) {
      continue;
    }
    seen.add(href);
    links.push(href);
  }
  return links;
}

function normalizeTodoStatus(value) {
  const normalized = String(value ?? "pending").trim().toLowerCase();
  if (normalized === "completed" || normalized === "done") {
    return "completed";
  }
  if (normalized === "in_progress" || normalized === "in-progress" || normalized === "active") {
    return "in_progress";
  }
  return "pending";
}

function normalizeTodoItem(item, index) {
  if (typeof item === "string") {
    const content = item.trim();
    if (!content) {
      return null;
    }
    return {
      id: `todo_${index + 1}`,
      content,
      status: "pending"
    };
  }

  if (!item || typeof item !== "object") {
    return null;
  }

  const content = String(item.content ?? item.text ?? "").trim();
  if (!content) {
    return null;
  }

  const idCandidate = String(item.id ?? "").trim();
  const safeId = idCandidate || `todo_${index + 1}`;
  return {
    id: safeId,
    content,
    status: normalizeTodoStatus(item.status)
  };
}

function findLineColumnFromOffset(text, offset) {
  const body = String(text ?? "");
  let line = 1;
  let column = 1;
  for (let i = 0; i < body.length && i < offset; i += 1) {
    if (body[i] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function toToolName(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_");
}

function normalizeCustomToolDefinition(raw, fallbackName) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const execute = raw.execute;
  if (typeof execute !== "function") {
    return null;
  }

  const name = toToolName(raw.name ?? fallbackName);
  if (!name) {
    return null;
  }

  const description = String(raw.description ?? `Custom tool ${name}`).trim();
  const parameters =
    raw.parameters && typeof raw.parameters === "object"
      ? raw.parameters
      : {
          type: "object",
          properties: {}
        };

  return {
    name,
    description,
    parameters,
    execute
  };
}

function compileGlobPattern(pattern) {
  const raw = toPosixPath(String(pattern || "**/*").trim() || "**/*");
  const doubleSlashToken = "\u0001";
  const doubleToken = "\u0002";

  const escaped = escapeRegExp(raw.replace(/\*\*\//g, doubleSlashToken).replace(/\*\*/g, doubleToken))
    .replace(new RegExp(doubleSlashToken, "g"), "(?:.*/)?")
    .replace(new RegExp(doubleToken, "g"), ".*")
    .replace(/\\\*/g, "[^/]*")
    .replace(/\\\?/g, "[^/]");

  return new RegExp(`^${escaped}$`);
}

function toLines(content) {
  const text = String(content ?? "").replace(/\r\n/g, "\n");
  const trailingNewline = text.endsWith("\n");
  const body = trailingNewline ? text.slice(0, -1) : text;
  const lines = body.length ? body.split("\n") : [];
  return { lines, trailingNewline };
}

function fromLines(lines, trailingNewline) {
  if (!lines.length) {
    return trailingNewline ? "\n" : "";
  }
  return `${lines.join("\n")}${trailingNewline ? "\n" : ""}`;
}

function parseUnifiedDiff(unifiedDiff) {
  const text = String(unifiedDiff ?? "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");

  const hunks = [];
  let current = null;

  for (const line of lines) {
    const headerMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (headerMatch) {
      if (current) {
        hunks.push(current);
      }
      current = {
        oldStart: Number(headerMatch[1]),
        oldCount: Number(headerMatch[2] || "1"),
        newStart: Number(headerMatch[3]),
        newCount: Number(headerMatch[4] || "1"),
        lines: []
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (/^( |\+|-)/.test(line)) {
      current.lines.push(line);
    }
  }

  if (current) {
    hunks.push(current);
  }

  if (!hunks.length) {
    throw new Error("No patch hunks found in unified_diff");
  }

  return hunks;
}

function applyHunks({ sourceLines, hunks }) {
  const output = [];
  let cursor = 0;
  let linesChanged = 0;

  for (const hunk of hunks) {
    const targetIndex = Math.max(0, hunk.oldStart - 1);

    if (targetIndex < cursor) {
      throw new Error("Overlapping or out-of-order patch hunks");
    }

    output.push(...sourceLines.slice(cursor, targetIndex));
    cursor = targetIndex;

    for (const rawLine of hunk.lines) {
      const marker = rawLine[0];
      const text = rawLine.slice(1);

      if (marker === " ") {
        const actual = sourceLines[cursor] ?? "";
        if (actual !== text) {
          throw new Error(`Patch context mismatch at line ${cursor + 1}`);
        }
        output.push(actual);
        cursor += 1;
        continue;
      }

      if (marker === "-") {
        const actual = sourceLines[cursor] ?? "";
        if (actual !== text) {
          throw new Error(`Patch delete mismatch at line ${cursor + 1}`);
        }
        cursor += 1;
        linesChanged += 1;
        continue;
      }

      if (marker === "+") {
        output.push(text);
        linesChanged += 1;
      }
    }
  }

  output.push(...sourceLines.slice(cursor));
  return { outputLines: output, linesChanged };
}

export class LocalFileTools {
  constructor({
    baseDir = process.cwd(),
    maxReadBytes = 200_000,
    maxListEntries = 500,
    maxGrepMatches = 200,
    enableShellTool = true,
    shellTimeoutMs = 15_000,
    maxShellTimeoutMs = 120_000,
    shellMaxOutputBytes = 32_000,
    shellAllowCommands = DEFAULT_SHELL_ALLOW_COMMANDS,
    shellDenyPatterns = DEFAULT_SHELL_DENY_PATTERNS,
    enableWebSearchTool = false,
    webSearchProvider = "duckduckgo",
    webSearchEndpoint = "",
    webSearchApiKey = "",
    webSearchTimeoutMs = DEFAULT_WEB_SEARCH_TIMEOUT_MS,
    webSearchMaxResults = DEFAULT_WEB_SEARCH_MAX_RESULTS,
    webFetchTimeoutMs = DEFAULT_WEB_FETCH_TIMEOUT_MS,
    webFetchMaxBytes = DEFAULT_WEB_FETCH_MAX_BYTES,
    codeSearchMaxMatches = DEFAULT_CODE_SEARCH_MAX_MATCHES,
    enableCustomTools = true,
    customToolDirs = ["tools"]
  } = {}) {
    this.baseDir = path.resolve(baseDir);
    this.maxReadBytes = maxReadBytes;
    this.maxListEntries = maxListEntries;
    this.maxGrepMatches = maxGrepMatches;
    this.enableShellTool = !!enableShellTool;
    this.shellTimeoutMs = clampNumber(shellTimeoutMs, 15_000, 100, 120_000);
    this.maxShellTimeoutMs = clampNumber(maxShellTimeoutMs, 120_000, 100, 300_000);
    this.shellMaxOutputBytes = clampNumber(shellMaxOutputBytes, 32_000, 512, 1_000_000);
    const normalizedAllowCommands = (Array.isArray(shellAllowCommands) ? shellAllowCommands : [])
      .map((value) => String(value).trim())
      .filter(Boolean);
    this.shellAllowCommands = new Set(
      normalizedAllowCommands.length ? normalizedAllowCommands : DEFAULT_SHELL_ALLOW_COMMANDS
    );

    const normalizedDenyPatterns = Array.isArray(shellDenyPatterns) ? shellDenyPatterns : [];
    this.shellDenyPatterns = (normalizedDenyPatterns.length ? normalizedDenyPatterns : DEFAULT_SHELL_DENY_PATTERNS).map(
      (pattern) => (pattern instanceof RegExp ? pattern : new RegExp(String(pattern), "i"))
    );
    this.enableWebSearchTool = !!enableWebSearchTool;
    this.webSearchProvider = String(webSearchProvider || "duckduckgo").toLowerCase();
    this.webSearchEndpoint = typeof webSearchEndpoint === "string" ? webSearchEndpoint.trim() : "";
    this.webSearchApiKey = String(webSearchApiKey || "").trim();
    this.webSearchTimeoutMs = clampNumber(webSearchTimeoutMs, DEFAULT_WEB_SEARCH_TIMEOUT_MS, 200, 60_000);
    this.webSearchMaxResults = clampNumber(webSearchMaxResults, DEFAULT_WEB_SEARCH_MAX_RESULTS, 1, 20);
    this.webFetchTimeoutMs = clampNumber(webFetchTimeoutMs, DEFAULT_WEB_FETCH_TIMEOUT_MS, 200, 120_000);
    this.webFetchMaxBytes = clampNumber(webFetchMaxBytes, DEFAULT_WEB_FETCH_MAX_BYTES, 8_192, 2_000_000);
    this.codeSearchMaxMatches = clampNumber(codeSearchMaxMatches, DEFAULT_CODE_SEARCH_MAX_MATCHES, 1, 2_000);
    this.enableCustomTools = enableCustomTools !== false;
    this.customToolDirs = Array.isArray(customToolDirs) ? customToolDirs.map((value) => String(value).trim()).filter(Boolean) : [];
    this.todoItems = [];
    this.planState = {
      active: false,
      goal: "",
      steps: [],
      entered_at: null,
      exited_at: null,
      summary: ""
    };
    this.taskRunner = null;
    this.questionHandler = null;
    this.customTools = new Map();
    this.customToolsLoaded = false;
    this.customToolsLoadError = null;
    this.customToolsLoadPromise = null;
  }

  setTaskRunner(fn) {
    this.taskRunner = typeof fn === "function" ? fn : null;
  }

  setQuestionHandler(fn) {
    this.questionHandler = typeof fn === "function" ? fn : null;
  }

  async ensureCustomToolsLoaded() {
    if (!this.enableCustomTools) {
      return this.customTools;
    }
    if (this.customToolsLoaded) {
      return this.customTools;
    }
    if (this.customToolsLoadPromise) {
      await this.customToolsLoadPromise;
      return this.customTools;
    }

    this.customToolsLoadPromise = (async () => {
      const discovered = new Map();
      for (const dir of this.customToolDirs) {
        let resolvedDir;
        try {
          resolvedDir = this.resolveWithinBase(dir);
        } catch {
          continue;
        }

        let entries = [];
        try {
          entries = await fs.readdir(resolvedDir, { withFileTypes: true });
        } catch (error) {
          if (error?.code === "ENOENT") {
            continue;
          }
          throw error;
        }

        for (const entry of entries) {
          if (!entry.isFile()) {
            continue;
          }
          if (!/\.(mjs|cjs|js)$/i.test(entry.name)) {
            continue;
          }

          const absolutePath = path.join(resolvedDir, entry.name);
          const baseName = toToolName(path.basename(entry.name, path.extname(entry.name)));
          try {
            const url = pathToFileURL(absolutePath).href;
            const mod = await import(url);
            const candidates = [];
            if (mod?.default && typeof mod.default === "object") {
              if (typeof mod.default.execute === "function") {
                candidates.push(mod.default);
              } else {
                for (const [exportName, exportValue] of Object.entries(mod.default)) {
                  if (exportValue && typeof exportValue === "object") {
                    candidates.push({
                      name: exportValue.name ?? exportName,
                      ...exportValue
                    });
                  }
                }
              }
            }
            for (const [exportName, exportValue] of Object.entries(mod ?? {})) {
              if (exportName === "default") {
                continue;
              }
              if (exportValue && typeof exportValue === "object") {
                candidates.push({
                  name: exportValue.name ?? exportName,
                  ...exportValue
                });
              }
            }

            for (const candidate of candidates) {
              const normalized = normalizeCustomToolDefinition(candidate, baseName);
              if (!normalized) {
                continue;
              }
              discovered.set(normalized.name, normalized);
            }
          } catch (error) {
            this.customToolsLoadError = `custom tool load failed at ${path.relative(this.baseDir, absolutePath)}: ${error.message}`;
          }
        }
      }
      this.customTools = discovered;
      this.customToolsLoaded = true;
      this.customToolsLoadPromise = null;
    })();

    await this.customToolsLoadPromise;
    return this.customTools;
  }

  async getToolDefinitions({ includeTaskTool = true, includePlanTools = true } = {}) {
    await this.ensureCustomToolsLoaded();

    const definitions = [
      {
        type: "function",
        function: {
          name: "list_files",
          description: "List files in a directory under the workspace.",
          parameters: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "Directory path relative to workspace root. Defaults to current directory."
              },
              recursive: {
                type: "boolean",
                description: "Whether to recurse into subdirectories."
              }
            }
          }
        }
      },
      {
        type: "function",
        function: {
          name: "ls",
          description: "Alias for list_files.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              recursive: { type: "boolean" }
            }
          }
        }
      },
      {
        type: "function",
        function: {
          name: "glob_files",
          description: "Find files by glob pattern under workspace.",
          parameters: {
            type: "object",
            properties: {
              pattern: {
                type: "string",
                description: "Glob pattern, for example src/**/*.js"
              },
              path: {
                type: "string",
                description: "Optional base directory under workspace."
              }
            },
            required: ["pattern"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "glob",
          description: "Alias for glob_files.",
          parameters: {
            type: "object",
            properties: {
              pattern: { type: "string" },
              path: { type: "string" }
            },
            required: ["pattern"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "grep_files",
          description: "Search file content by text or regex under workspace.",
          parameters: {
            type: "object",
            properties: {
              pattern: {
                type: "string",
                description: "Text or regex pattern to search."
              },
              path: {
                type: "string",
                description: "Base directory under workspace."
              },
              recursive: {
                type: "boolean"
              },
              regex: {
                type: "boolean",
                description: "Treat pattern as regex when true."
              },
              case_sensitive: {
                type: "boolean"
              },
              max_matches: {
                type: "number"
              }
            },
            required: ["pattern"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "grep",
          description: "Alias for grep_files.",
          parameters: {
            type: "object",
            properties: {
              pattern: { type: "string" },
              path: { type: "string" },
              recursive: { type: "boolean" },
              regex: { type: "boolean" },
              case_sensitive: { type: "boolean" },
              max_matches: { type: "number" }
            },
            required: ["pattern"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read file content from workspace.",
          parameters: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "File path relative to workspace root."
              }
            },
            required: ["path"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "read",
          description: "Alias for read_file.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" }
            },
            required: ["path"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "write_file",
          description: "Write content to a file in workspace.",
          parameters: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "File path relative to workspace root."
              },
              content: {
                type: "string",
                description: "Content to write."
              },
              append: {
                type: "boolean",
                description: "Append instead of overwrite."
              }
            },
            required: ["path", "content"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "write",
          description: "Alias for write_file.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
              append: { type: "boolean" }
            },
            required: ["path", "content"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "create_file",
          description: "Create file; fails if file exists unless overwrite=true.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
              overwrite: { type: "boolean" }
            },
            required: ["path"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "edit",
          description: "Alias for edit_file.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              search: { type: "string" },
              replace: { type: "string" },
              all: { type: "boolean" }
            },
            required: ["path", "search", "replace"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "edit_file",
          description: "Edit file by replacing search text with replacement.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              search: { type: "string" },
              replace: { type: "string" },
              all: { type: "boolean" }
            },
            required: ["path", "search", "replace"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "replace_in_file",
          description: "Replace text in file content.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              search: { type: "string" },
              replace: { type: "string" },
              all: { type: "boolean" }
            },
            required: ["path", "search", "replace"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "insert_in_file",
          description: "Insert content by line number or anchor text.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
              line: { type: "number" },
              anchor: { type: "string" },
              position: { type: "string", description: "before or after anchor" }
            },
            required: ["path", "content"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "patch_file",
          description: "Apply unified diff patch to a file.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              unified_diff: { type: "string" }
            },
            required: ["path", "unified_diff"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "apply_patch",
          description:
            "Apply a strict multi-file patch envelope with *** Begin Patch / *** End Patch grammar (add/update/delete/move).",
          parameters: {
            type: "object",
            properties: {
              patch: {
                type: "string",
                description: "Patch text following the apply_patch grammar."
              },
              patch_text: {
                type: "string",
                description: "Alias for patch text."
              },
              patchText: {
                type: "string",
                description: "Alias for patch text."
              }
            },
            required: []
          }
        }
      },
      {
        type: "function",
        function: {
          name: "move_file",
          description: "Move or rename a file within workspace.",
          parameters: {
            type: "object",
            properties: {
              from: { type: "string" },
              to: { type: "string" },
              overwrite: { type: "boolean" }
            },
            required: ["from", "to"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "delete_file",
          description: "Delete file or directory in workspace.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              recursive: { type: "boolean" }
            },
            required: ["path"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "search_web",
          description: "Search public web results for a query and return titles, URLs, and snippets.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
              count: { type: "number" },
              domains: {
                type: "array",
                items: { type: "string" }
              },
              safe_search: { type: "boolean" }
            },
            required: ["query"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "websearch",
          description: "Alias for search_web.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
              count: { type: "number" },
              domains: {
                type: "array",
                items: { type: "string" }
              },
              safe_search: { type: "boolean" }
            },
            required: ["query"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "execute_shell",
          description:
            "Execute a shell command in workspace with safety controls (allowlist, denylist, timeout, output truncation).",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string" },
              cwd: { type: "string" },
              timeout_ms: { type: "number" }
            },
            required: ["command"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "bash",
          description: "Alias for execute_shell.",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string" },
              cwd: { type: "string" },
              timeout_ms: { type: "number" }
            },
            required: ["command"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "webfetch",
          description: "Fetch a URL and return normalized response content with size and timeout limits.",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string" },
              method: { type: "string" },
              headers: { type: "object" },
              format: { type: "string", description: "text|html|json" },
              timeout_ms: { type: "number" },
              max_bytes: { type: "number" }
            },
            required: ["url"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "codesearch",
          description: "Search code in workspace and return ranked file/line matches.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
              path: { type: "string" },
              regex: { type: "boolean" },
              case_sensitive: { type: "boolean" },
              max_matches: { type: "number" }
            },
            required: ["query"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "lsp",
          description: "Lightweight language-intelligence helper for symbols/definitions/diagnostics.",
          parameters: {
            type: "object",
            properties: {
              action: { type: "string", description: "symbols|definition|diagnostics" },
              path: { type: "string" },
              symbol: { type: "string" },
              line: { type: "number" },
              column: { type: "number" },
              max_results: { type: "number" }
            }
          }
        }
      },
      {
        type: "function",
        function: {
          name: "question",
          description: "Ask one or more structured questions to the user and return selected answers.",
          parameters: {
            type: "object",
            properties: {
              questions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    header: { type: "string" },
                    question: { type: "string" },
                    multiple: { type: "boolean" },
                    options: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          label: { type: "string" },
                          description: { type: "string" }
                        }
                      }
                    }
                  },
                  required: ["id", "question", "options"]
                }
              }
            },
            required: ["questions"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "todowrite",
          description: "Write or merge todo items used for execution coordination.",
          parameters: {
            type: "object",
            properties: {
              todos: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    content: { type: "string" },
                    status: { type: "string" }
                  }
                }
              },
              merge: { type: "boolean" },
              clear: { type: "boolean" }
            }
          }
        }
      },
      {
        type: "function",
        function: {
          name: "todoread",
          description: "Read current todo list state.",
          parameters: {
            type: "object",
            properties: {}
          }
        }
      },
      {
        type: "function",
        function: {
          name: "skill",
          description: "Load and summarize SKILL.md instructions from workspace.",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string" },
              path: { type: "string" },
              query: { type: "string" },
              max_lines: { type: "number" }
            }
          }
        }
      },
      {
        type: "function",
        function: {
          name: "batch",
          description: "Execute multiple tool calls in parallel or sequence with isolated outcomes.",
          parameters: {
            type: "object",
            properties: {
              calls: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    tool: { type: "string" },
                    arguments: {},
                    input: {}
                  }
                }
              },
              parallel: { type: "boolean" },
              continue_on_error: { type: "boolean" }
            },
            required: ["calls"]
          }
        }
      }
    ];

    if (includeTaskTool) {
      definitions.push({
        type: "function",
        function: {
          name: "task",
          description: "Delegate work to a scoped sub-task execution context.",
          parameters: {
            type: "object",
            properties: {
              prompt: { type: "string" },
              max_tool_rounds: { type: "number" }
            },
            required: ["prompt"]
          }
        }
      });
    }

    if (includePlanTools) {
      definitions.push(
        {
          type: "function",
          function: {
            name: "plan_enter",
            description: "Enter explicit planning mode and persist the active execution plan context.",
            parameters: {
              type: "object",
              properties: {
                goal: { type: "string" },
                steps: {
                  type: "array",
                  items: { type: "string" }
                }
              },
              required: ["goal"]
            }
          }
        },
        {
          type: "function",
          function: {
            name: "plan_exit",
            description: "Exit planning mode and persist summary for the just-completed plan.",
            parameters: {
              type: "object",
              properties: {
                summary: { type: "string" }
              }
            }
          }
        }
      );
    }

    for (const tool of this.customTools.values()) {
      definitions.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      });
    }

    return definitions;
  }

  resolveWithinBase(inputPath) {
    const candidate = path.resolve(this.baseDir, inputPath);
    const base = this.baseDir.endsWith(path.sep) ? this.baseDir : `${this.baseDir}${path.sep}`;

    if (candidate !== this.baseDir && !candidate.startsWith(base)) {
      throw new Error(`Path is outside workspace: ${inputPath}`);
    }

    return candidate;
  }

  async walkEntries(startPath, recursive = false) {
    const output = [];

    const walk = async (current) => {
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (output.length >= this.maxListEntries) {
          return;
        }

        const full = path.join(current, entry.name);
        const rel = path.relative(this.baseDir, full) || ".";

        output.push({
          path: rel,
          type: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other"
        });

        if (recursive && entry.isDirectory()) {
          await walk(full);
        }
      }
    };

    await walk(startPath);

    return {
      entries: output,
      truncated: output.length >= this.maxListEntries
    };
  }

  async listFiles({ path: rawPath = ".", recursive = false } = {}) {
    const dirPath = this.resolveWithinBase(normalizePath(rawPath));
    const { entries, truncated } = await this.walkEntries(dirPath, recursive);

    return {
      ok: true,
      base_dir: this.baseDir,
      listed: entries.length,
      truncated,
      entries
    };
  }

  async globFiles({ pattern, path: rawPath = "." } = {}) {
    if (!pattern || typeof pattern !== "string") {
      throw new Error("pattern is required");
    }

    const rootPath = this.resolveWithinBase(normalizePath(rawPath));
    const regex = compileGlobPattern(pattern);
    const { entries, truncated } = await this.walkEntries(rootPath, true);

    const matches = entries.filter((entry) => {
      const relFromRoot = toPosixPath(path.relative(rawPath === "." ? this.baseDir : rootPath, this.resolveWithinBase(entry.path)));
      return regex.test(relFromRoot);
    });

    return {
      ok: true,
      base_dir: this.baseDir,
      path: path.relative(this.baseDir, rootPath) || ".",
      pattern,
      count: matches.length,
      truncated,
      matches
    };
  }

  async grepFiles({
    pattern,
    path: rawPath = ".",
    recursive = true,
    regex = false,
    case_sensitive = false,
    max_matches
  } = {}) {
    if (!pattern || typeof pattern !== "string") {
      throw new Error("pattern is required");
    }

    const rootPath = this.resolveWithinBase(normalizePath(rawPath));
    const { entries, truncated } = await this.walkEntries(rootPath, recursive);

    const maxMatches = Number.isFinite(Number(max_matches))
      ? Math.max(1, Math.min(2000, Number(max_matches)))
      : this.maxGrepMatches;

    const flags = case_sensitive ? "g" : "gi";
    const matcher = regex ? new RegExp(pattern, flags) : new RegExp(escapeRegExp(pattern), flags);

    const matches = [];
    let scannedFiles = 0;

    for (const entry of entries) {
      if (entry.type !== "file") {
        continue;
      }

      if (matches.length >= maxMatches) {
        break;
      }

      scannedFiles += 1;
      const absolute = this.resolveWithinBase(entry.path);

      let text;
      try {
        text = await fs.readFile(absolute, "utf8");
      } catch {
        continue;
      }

      const lines = text.replace(/\r\n/g, "\n").split("\n");

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        matcher.lastIndex = 0;

        while (true) {
          const found = matcher.exec(line);
          if (!found) {
            break;
          }

          matches.push({
            path: entry.path,
            line: lineIndex + 1,
            column: (found.index ?? 0) + 1,
            text: line
          });

          if (matches.length >= maxMatches) {
            break;
          }

          if ((found[0] || "").length === 0) {
            matcher.lastIndex += 1;
          }
        }

        if (matches.length >= maxMatches) {
          break;
        }
      }
    }

    return {
      ok: true,
      pattern,
      regex: !!regex,
      case_sensitive: !!case_sensitive,
      path: path.relative(this.baseDir, rootPath) || ".",
      scanned_files: scannedFiles,
      matches,
      count: matches.length,
      truncated: truncated || matches.length >= maxMatches
    };
  }

  async readFile({ path: rawPath } = {}) {
    if (!rawPath || typeof rawPath !== "string") {
      throw new Error("path is required");
    }

    const filePath = this.resolveWithinBase(rawPath);
    const data = await fs.readFile(filePath);
    const clipped = data.byteLength > this.maxReadBytes;
    const body = clipped ? data.subarray(0, this.maxReadBytes).toString("utf8") : data.toString("utf8");

    return {
      ok: true,
      path: path.relative(this.baseDir, filePath),
      bytes: data.byteLength,
      truncated: clipped,
      content: body
    };
  }

  async writeFile({ path: rawPath, content, append = false } = {}) {
    if (!rawPath || typeof rawPath !== "string") {
      throw new Error("path is required");
    }

    if (typeof content !== "string") {
      throw new Error("content must be a string");
    }

    const filePath = this.resolveWithinBase(rawPath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    if (append) {
      await fs.appendFile(filePath, content, "utf8");
    } else {
      await fs.writeFile(filePath, content, "utf8");
    }

    return {
      ok: true,
      path: path.relative(this.baseDir, filePath),
      appended: !!append,
      bytes_written: Buffer.byteLength(content)
    };
  }

  async createFile({ path: rawPath, content = "", overwrite = false } = {}) {
    if (!rawPath || typeof rawPath !== "string") {
      throw new Error("path is required");
    }

    if (typeof content !== "string") {
      throw new Error("content must be a string");
    }

    const filePath = this.resolveWithinBase(rawPath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    if (!overwrite) {
      try {
        await fs.stat(filePath);
        throw new Error(`file already exists: ${rawPath}`);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }

    await fs.writeFile(filePath, content, "utf8");

    return {
      ok: true,
      path: path.relative(this.baseDir, filePath),
      created: true,
      overwrite: !!overwrite,
      bytes_written: Buffer.byteLength(content)
    };
  }

  async replaceInFile({ path: rawPath, search, replace, all = false } = {}) {
    if (!rawPath || typeof rawPath !== "string") {
      throw new Error("path is required");
    }

    if (typeof search !== "string" || search.length === 0) {
      throw new Error("search must be a non-empty string");
    }

    if (typeof replace !== "string") {
      throw new Error("replace must be a string");
    }

    const filePath = this.resolveWithinBase(rawPath);
    const before = await fs.readFile(filePath, "utf8");

    if (!before.includes(search)) {
      return {
        ok: false,
        path: path.relative(this.baseDir, filePath),
        replacements: 0,
        error: "search text not found"
      };
    }

    const replacements = all ? before.split(search).length - 1 : 1;
    const after = all ? before.split(search).join(replace) : before.replace(search, replace);
    await fs.writeFile(filePath, after, "utf8");

    return {
      ok: true,
      path: path.relative(this.baseDir, filePath),
      replacements,
      bytes_written: Buffer.byteLength(after)
    };
  }

  async editFile(args = {}) {
    return this.replaceInFile(args);
  }

  async insertInFile({ path: rawPath, content, line, anchor, position = "after" } = {}) {
    if (!rawPath || typeof rawPath !== "string") {
      throw new Error("path is required");
    }

    if (typeof content !== "string") {
      throw new Error("content must be a string");
    }

    const filePath = this.resolveWithinBase(rawPath);
    const original = await fs.readFile(filePath, "utf8");
    const { lines, trailingNewline } = toLines(original);
    const insertion = String(content).replace(/\r\n/g, "\n").split("\n");

    let insertAt;

    if (Number.isFinite(Number(line))) {
      const requested = Math.round(Number(line));
      insertAt = Math.max(0, Math.min(lines.length, requested - 1));
    } else if (typeof anchor === "string" && anchor.length > 0) {
      const index = lines.findIndex((value) => value.includes(anchor));
      if (index < 0) {
        return {
          ok: false,
          path: path.relative(this.baseDir, filePath),
          inserted_lines: 0,
          error: "anchor not found"
        };
      }
      insertAt = position === "before" ? index : index + 1;
    } else {
      insertAt = lines.length;
    }

    const output = [...lines.slice(0, insertAt), ...insertion, ...lines.slice(insertAt)];
    const updated = fromLines(output, trailingNewline);
    await fs.writeFile(filePath, updated, "utf8");

    return {
      ok: true,
      path: path.relative(this.baseDir, filePath),
      inserted_lines: insertion.length,
      line: insertAt + 1,
      bytes_written: Buffer.byteLength(updated)
    };
  }

  async patchFile({ path: rawPath, unified_diff } = {}) {
    if (!rawPath || typeof rawPath !== "string") {
      throw new Error("path is required");
    }

    if (typeof unified_diff !== "string" || !unified_diff.trim()) {
      throw new Error("unified_diff is required");
    }

    const filePath = this.resolveWithinBase(rawPath);
    const original = await fs.readFile(filePath, "utf8");
    const { lines: sourceLines, trailingNewline } = toLines(original);
    const hunks = parseUnifiedDiff(unified_diff);
    const { outputLines, linesChanged } = applyHunks({ sourceLines, hunks });
    const updated = fromLines(outputLines, trailingNewline);

    await fs.writeFile(filePath, updated, "utf8");

    return {
      ok: true,
      path: path.relative(this.baseDir, filePath),
      hunks_applied: hunks.length,
      lines_changed: linesChanged,
      bytes_written: Buffer.byteLength(updated)
    };
  }

  async applyPatch({ patch: patchInput, patch_text, patchText } = {}) {
    const patch = String(patchInput ?? patch_text ?? patchText ?? "");
    if (!patch.trim()) {
      throw new Error("patch is required");
    }

    const parsed = parseApplyPatchText(patch);
    const prepared = [];
    const occupiedTargets = new Set();

    for (const operation of parsed.operations) {
      if (operation.type === "add") {
        const targetPath = this.resolveWithinBase(operation.path);
        const targetKey = targetPath;
        if (occupiedTargets.has(targetKey)) {
          throw new Error(`Duplicate target in patch: ${operation.path}`);
        }
        occupiedTargets.add(targetKey);

        let exists = false;
        try {
          const stat = await fs.stat(targetPath);
          exists = stat.isFile() || stat.isDirectory();
        } catch (error) {
          if (error?.code !== "ENOENT") {
            throw error;
          }
        }
        if (exists) {
          throw new Error(`apply_patch verification failed: file already exists: ${operation.path}`);
        }

        const additions = operation.content ? operation.content.split("\n").length : 0;
        prepared.push({
          type: "add",
          sourcePath: targetPath,
          targetPath,
          relativeSource: path.relative(this.baseDir, targetPath),
          relativeTarget: path.relative(this.baseDir, targetPath),
          beforeContent: "",
          afterContent: operation.content,
          additions,
          deletions: 0
        });
        continue;
      }

      if (operation.type === "delete") {
        const sourcePath = this.resolveWithinBase(operation.path);
        const stat = await fs.stat(sourcePath);
        if (!stat.isFile()) {
          throw new Error(`apply_patch verification failed: not a file: ${operation.path}`);
        }
        const beforeContent = await fs.readFile(sourcePath, "utf8");
        const { lines } = toLines(beforeContent);
        prepared.push({
          type: "delete",
          sourcePath,
          targetPath: sourcePath,
          relativeSource: path.relative(this.baseDir, sourcePath),
          relativeTarget: path.relative(this.baseDir, sourcePath),
          beforeContent,
          afterContent: "",
          additions: 0,
          deletions: lines.length
        });
        continue;
      }

      const sourcePath = this.resolveWithinBase(operation.path);
      const sourceStat = await fs.stat(sourcePath);
      if (!sourceStat.isFile()) {
        throw new Error(`apply_patch verification failed: not a file: ${operation.path}`);
      }
      const beforeContent = await fs.readFile(sourcePath, "utf8");
      const { lines: sourceLines, trailingNewline } = toLines(beforeContent);
      const updated = applyUpdateChunksToLines(sourceLines, operation.chunks);
      const afterContent = fromLines(updated.lines, trailingNewline);

      const targetPath = operation.move_to ? this.resolveWithinBase(operation.move_to) : sourcePath;
      const targetKey = targetPath;
      if (occupiedTargets.has(targetKey)) {
        throw new Error(`Duplicate target in patch: ${operation.move_to || operation.path}`);
      }
      occupiedTargets.add(targetKey);

      if (operation.move_to) {
        try {
          const targetStat = await fs.stat(targetPath);
          if (targetStat) {
            throw new Error(`apply_patch verification failed: move destination exists: ${operation.move_to}`);
          }
        } catch (error) {
          if (error?.code !== "ENOENT") {
            throw error;
          }
        }
      }

      prepared.push({
        type: operation.move_to ? "move" : "update",
        sourcePath,
        targetPath,
        relativeSource: path.relative(this.baseDir, sourcePath),
        relativeTarget: path.relative(this.baseDir, targetPath),
        beforeContent,
        afterContent,
        additions: updated.additions,
        deletions: updated.deletions
      });
    }

    for (const change of prepared) {
      if (change.type === "delete") {
        await fs.rm(change.sourcePath);
        continue;
      }

      await fs.mkdir(path.dirname(change.targetPath), { recursive: true });
      await fs.writeFile(change.targetPath, change.afterContent, "utf8");
      if (change.type === "move" && change.sourcePath !== change.targetPath) {
        await fs.rm(change.sourcePath);
      }
    }

    const files = prepared.map((change) => ({
      type: change.type,
      path: change.relativeSource,
      target_path: change.relativeTarget,
      additions: change.additions,
      deletions: change.deletions
    }));

    return {
      ok: true,
      operations_applied: prepared.length,
      files,
      total_additions: files.reduce((sum, file) => sum + Number(file.additions || 0), 0),
      total_deletions: files.reduce((sum, file) => sum + Number(file.deletions || 0), 0)
    };
  }

  async moveFile({ from, to, overwrite = false } = {}) {
    if (!from || typeof from !== "string") {
      throw new Error("from is required");
    }

    if (!to || typeof to !== "string") {
      throw new Error("to is required");
    }

    const source = this.resolveWithinBase(from);
    const destination = this.resolveWithinBase(to);

    if (!overwrite) {
      try {
        await fs.stat(destination);
        throw new Error(`destination already exists: ${to}`);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    } else {
      await fs.rm(destination, { recursive: true, force: true });
    }

    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(source, destination);

    return {
      ok: true,
      from: path.relative(this.baseDir, source),
      to: path.relative(this.baseDir, destination),
      moved: true,
      overwrite: !!overwrite
    };
  }

  async deleteFile({ path: rawPath, recursive = false } = {}) {
    if (!rawPath || typeof rawPath !== "string") {
      throw new Error("path is required");
    }

    const target = this.resolveWithinBase(rawPath);
    const stat = await fs.stat(target);

    if (stat.isDirectory() && !recursive) {
      throw new Error("path is a directory; set recursive=true to delete directory");
    }

    await fs.rm(target, {
      recursive: !!recursive,
      force: false
    });

    return {
      ok: true,
      path: path.relative(this.baseDir, target),
      deleted: true,
      type: stat.isDirectory() ? "dir" : "file"
    };
  }

  evaluateShellPolicy(command) {
    if (!this.enableShellTool) {
      return {
        allowed: false,
        blocked_reason: "shell tool is disabled"
      };
    }

    const text = String(command ?? "").trim();
    if (!text) {
      return {
        allowed: false,
        blocked_reason: "command is required"
      };
    }

    if (text.includes("\n")) {
      return {
        allowed: false,
        blocked_reason: "multi-line commands are not allowed"
      };
    }

    for (const pattern of this.shellDenyPatterns) {
      if (pattern.test(text)) {
        return {
          allowed: false,
          blocked_reason: `command blocked by policy (${pattern})`
        };
      }
    }

    const executable = extractExecutable(text);
    if (!executable) {
      return {
        allowed: false,
        blocked_reason: "unable to determine executable"
      };
    }

    if (this.shellAllowCommands.size && !this.shellAllowCommands.has(executable)) {
      return {
        allowed: false,
        blocked_reason: `command not in allowlist (${executable})`,
        executable
      };
    }

    return {
      allowed: true,
      executable
    };
  }

  async executeShell({ command, cwd = ".", timeout_ms } = {}) {
    const policy = this.evaluateShellPolicy(command);
    const commandText = String(command ?? "");

    if (!policy.allowed) {
      return {
        ok: false,
        blocked: true,
        blocked_reason: policy.blocked_reason,
        command: commandText
      };
    }

    const workingDir = this.resolveWithinBase(normalizePath(cwd));
    const timeoutMs = clampNumber(timeout_ms, this.shellTimeoutMs, 100, this.maxShellTimeoutMs);
    const startedAt = Date.now();
    const stdoutState = {
      chunks: [],
      bytes: 0,
      truncated: false
    };
    const stderrState = {
      chunks: [],
      bytes: 0,
      truncated: false
    };

    return new Promise((resolve) => {
      const child = spawn("/bin/zsh", ["-lc", commandText], {
        cwd: workingDir,
        env: process.env
      });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      child.stdout.on("data", (chunk) => appendBufferChunk(stdoutState, chunk, this.shellMaxOutputBytes));
      child.stderr.on("data", (chunk) => appendBufferChunk(stderrState, chunk, this.shellMaxOutputBytes));

      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({
          ok: false,
          command: commandText,
          cwd: path.relative(this.baseDir, workingDir) || ".",
          executable: policy.executable,
          timed_out: timedOut,
          truncated: stdoutState.truncated || stderrState.truncated,
          exit_code: null,
          signal: null,
          stdout: Buffer.concat(stdoutState.chunks).toString("utf8"),
          stderr: Buffer.concat(stderrState.chunks).toString("utf8"),
          duration_ms: Date.now() - startedAt,
          error: error.message
        });
      });

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({
          ok: !timedOut && code === 0,
          command: commandText,
          cwd: path.relative(this.baseDir, workingDir) || ".",
          executable: policy.executable,
          timed_out: timedOut,
          truncated: stdoutState.truncated || stderrState.truncated,
          exit_code: Number.isInteger(code) ? code : null,
          signal: signal ?? null,
          stdout: Buffer.concat(stdoutState.chunks).toString("utf8"),
          stderr: Buffer.concat(stderrState.chunks).toString("utf8"),
          duration_ms: Date.now() - startedAt
        });
      });
    });
  }

  async searchWebViaDuckDuckGo({ query, count, safeSearch }) {
    const searchUrl = new URL("https://api.duckduckgo.com/");
    searchUrl.searchParams.set("q", query);
    searchUrl.searchParams.set("format", "json");
    searchUrl.searchParams.set("no_redirect", "1");
    searchUrl.searchParams.set("no_html", "1");
    searchUrl.searchParams.set("skip_disambig", "1");
    searchUrl.searchParams.set("kp", safeSearch ? "1" : "-1");

    const timeout = withTimeoutAbort(this.webSearchTimeoutMs);
    try {
      const response = await fetch(searchUrl, {
        method: "GET",
        signal: timeout.signal,
        headers: {
          "user-agent": "starcode/0.1 (web-search-tool)"
        }
      });

      if (!response.ok) {
        throw new Error("duckduckgo response " + response.status);
      }

      const payload = await response.json();
      const results = [];

      if (payload?.AbstractURL && payload?.AbstractText) {
        results.push({
          title: String(payload.Heading || query),
          url: String(payload.AbstractURL),
          snippet: String(payload.AbstractText),
          source: "duckduckgo"
        });
      }

      flattenDuckDuckGoTopics(payload?.RelatedTopics ?? [], results);

      return results.slice(0, Math.max(1, count * 3));
    } finally {
      timeout.clear();
    }
  }

  async searchWebViaEndpoint({ query, count, domains, safeSearch }) {
    if (!this.webSearchEndpoint) {
      throw new Error("web search endpoint is not configured");
    }

    const timeout = withTimeoutAbort(this.webSearchTimeoutMs);
    try {
      const headers = {
        "content-type": "application/json"
      };

      if (this.webSearchApiKey) {
        headers.authorization = "Bearer " + this.webSearchApiKey;
      }

      const response = await fetch(this.webSearchEndpoint, {
        method: "POST",
        signal: timeout.signal,
        headers,
        body: JSON.stringify({
          query,
          count,
          domains,
          safe_search: !!safeSearch
        })
      });

      if (!response.ok) {
        throw new Error("web search endpoint response " + response.status);
      }

      const payload = await response.json();
      const rows = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.results)
          ? payload.results
          : Array.isArray(payload?.data)
            ? payload.data
            : [];

      return rows
        .map((item) => normalizeSearchResultItem(item, this.webSearchProvider === "endpoint" ? "endpoint" : "web"))
        .filter(Boolean);
    } finally {
      timeout.clear();
    }
  }

  async searchWeb({ query, count, domains, safe_search = true } = {}) {
    if (!this.enableWebSearchTool) {
      return {
        ok: false,
        blocked: true,
        blocked_reason: "web search tool is disabled"
      };
    }

    if (!query || typeof query !== "string") {
      throw new Error("query is required");
    }

    const requestedCount = Number.isFinite(Number(count)) ? Math.round(Number(count)) : this.webSearchMaxResults;
    const normalizedCount = Math.max(1, Math.min(this.webSearchMaxResults, requestedCount));
    const requestedDomains = normalizeDomainList(domains);
    const startedAt = Date.now();

    try {
      let rawResults;

      if (this.webSearchProvider === "endpoint" || this.webSearchEndpoint) {
        rawResults = await this.searchWebViaEndpoint({
          query,
          count: normalizedCount,
          domains: requestedDomains,
          safeSearch: !!safe_search
        });
      } else {
        rawResults = await this.searchWebViaDuckDuckGo({
          query,
          count: normalizedCount,
          safeSearch: !!safe_search
        });
      }

      const unique = [];
      const seen = new Set();

      for (const row of rawResults) {
        const normalized = normalizeSearchResultItem(row, this.webSearchProvider);
        if (!normalized) {
          continue;
        }

        if (!hostMatchesDomains(normalized.url, requestedDomains)) {
          continue;
        }

        if (seen.has(normalized.url)) {
          continue;
        }

        seen.add(normalized.url);
        unique.push(normalized);
      }

      const results = unique.slice(0, normalizedCount);

      return {
        ok: true,
        query,
        provider: this.webSearchProvider === "endpoint" || this.webSearchEndpoint ? "endpoint" : "duckduckgo",
        count: results.length,
        truncated: unique.length > results.length,
        requested_count: requestedCount,
        max_count: this.webSearchMaxResults,
        domains: requestedDomains,
        safe_search: !!safe_search,
        results,
        duration_ms: Date.now() - startedAt
      };
    } catch (error) {
      return {
        ok: false,
        query,
        provider: this.webSearchProvider === "endpoint" || this.webSearchEndpoint ? "endpoint" : "duckduckgo",
        error: error.message,
        results: [],
        duration_ms: Date.now() - startedAt
      };
    }
  }

  async executeWebFetch({ url, method = "GET", headers = {}, format = "text", timeout_ms, max_bytes } = {}) {
    const target = String(url ?? "").trim();
    if (!target) {
      throw new Error("url is required");
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(target);
    } catch {
      throw new Error("invalid url");
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error("only http/https urls are allowed");
    }

    const timeoutMs = clampNumber(timeout_ms, this.webFetchTimeoutMs, 200, 120_000);
    const maxBytes = clampNumber(max_bytes, this.webFetchMaxBytes, 8_192, 2_000_000);
    const timeout = withTimeoutAbort(timeoutMs);
    const startedAt = Date.now();

    try {
      const safeHeaders = {};
      if (headers && typeof headers === "object") {
        for (const [key, value] of Object.entries(headers)) {
          const safeKey = String(key).trim();
          if (!safeKey) {
            continue;
          }
          safeHeaders[safeKey] = String(value ?? "");
        }
      }
      if (!safeHeaders["user-agent"] && !safeHeaders["User-Agent"]) {
        safeHeaders["user-agent"] = "starcode/0.1 (webfetch-tool)";
      }

      const response = await fetch(parsedUrl, {
        method: String(method ?? "GET").toUpperCase(),
        headers: safeHeaders,
        signal: timeout.signal,
        redirect: "follow"
      });
      const raw = Buffer.from(await response.arrayBuffer());
      const truncated = raw.length > maxBytes;
      const body = truncated ? raw.subarray(0, maxBytes) : raw;
      const contentType = String(response.headers?.get?.("content-type") ?? "").toLowerCase();
      const bodyText = body.toString("utf8");

      let content = bodyText;
      let links = [];
      let json = null;
      const desiredFormat = String(format ?? "text").toLowerCase();

      if (contentType.includes("text/html")) {
        links = extractLinksFromHtml(bodyText, 100);
        content = desiredFormat === "html" ? bodyText : stripHtml(bodyText);
      } else if (contentType.includes("application/json") || desiredFormat === "json") {
        try {
          json = JSON.parse(bodyText);
          content = JSON.stringify(json, null, 2);
        } catch {
          content = bodyText;
        }
      }

      return {
        ok: true,
        url: parsedUrl.toString(),
        status: response.status,
        status_text: response.statusText,
        content_type: contentType || "unknown",
        bytes: raw.length,
        truncated,
        format: desiredFormat,
        content,
        links,
        json,
        duration_ms: Date.now() - startedAt
      };
    } catch (error) {
      return {
        ok: false,
        url: parsedUrl.toString(),
        error: error.message,
        duration_ms: Date.now() - startedAt
      };
    } finally {
      timeout.clear();
    }
  }

  async executeCodeSearch({ query, path: rawPath = ".", regex = false, case_sensitive = false, max_matches } = {}) {
    if (!query || typeof query !== "string") {
      throw new Error("query is required");
    }

    const limit = Number.isFinite(Number(max_matches))
      ? Math.max(1, Math.min(2000, Number(max_matches)))
      : this.codeSearchMaxMatches;

    const result = await this.grepFiles({
      pattern: query,
      path: rawPath,
      recursive: true,
      regex: !!regex,
      case_sensitive: !!case_sensitive,
      max_matches: limit
    });

    const byFile = new Map();
    for (const match of result.matches) {
      const bucket = byFile.get(match.path) ?? {
        path: match.path,
        hits: 0,
        first_line: match.line
      };
      bucket.hits += 1;
      if (match.line < bucket.first_line) {
        bucket.first_line = match.line;
      }
      byFile.set(match.path, bucket);
    }

    const files = [...byFile.values()].sort((a, b) => b.hits - a.hits || a.first_line - b.first_line);
    return {
      ok: true,
      query,
      regex: !!regex,
      case_sensitive: !!case_sensitive,
      path: result.path,
      count: result.count,
      files,
      matches: result.matches,
      truncated: result.truncated
    };
  }

  async listSymbolsInFile(filePath, { maxResults = 100 } = {}) {
    const absolute = this.resolveWithinBase(filePath);
    const text = await fs.readFile(absolute, "utf8");
    const symbols = [];

    for (const pattern of DEFAULT_SYMBOL_PATTERNS) {
      pattern.regex.lastIndex = 0;
      let match;
      while ((match = pattern.regex.exec(text))) {
        const name = String(match[1] ?? "").trim();
        if (!name) {
          continue;
        }
        const offset = Number(match.index ?? 0);
        const position = findLineColumnFromOffset(text, offset);
        symbols.push({
          name,
          kind: pattern.kind,
          line: position.line,
          column: position.column
        });
        if (symbols.length >= maxResults) {
          break;
        }
      }
      if (symbols.length >= maxResults) {
        break;
      }
    }

    return symbols;
  }

  async runNodeSyntaxCheck(filePath) {
    const absolute = this.resolveWithinBase(filePath);
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ["--check", absolute], {
        cwd: this.baseDir,
        env: process.env
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk ?? "");
      });
      child.on("close", (code) => {
        resolve({
          ok: code === 0,
          code: Number.isFinite(code) ? code : null,
          message: stderr.trim()
        });
      });
      child.on("error", (error) => {
        resolve({
          ok: false,
          code: null,
          message: error.message
        });
      });
    });
  }

  async executeLsp({
    action = "symbols",
    path: rawPath,
    symbol: symbolInput,
    line,
    column,
    max_results
  } = {}) {
    const mode = String(action ?? "symbols").toLowerCase();
    const maxResults = Number.isFinite(Number(max_results)) ? Math.max(1, Math.min(500, Number(max_results))) : 100;

    if (mode === "symbols") {
      if (!rawPath || typeof rawPath !== "string") {
        throw new Error("path is required for action=symbols");
      }
      const symbols = await this.listSymbolsInFile(rawPath, { maxResults });
      return {
        ok: true,
        action: mode,
        provider: "builtin-lite",
        path: String(rawPath),
        symbols,
        count: symbols.length
      };
    }

    if (mode === "definition") {
      let symbol = String(symbolInput ?? "").trim();

      if (!symbol && rawPath && Number.isFinite(Number(line))) {
        const file = this.resolveWithinBase(rawPath);
        const text = await fs.readFile(file, "utf8");
        const lines = text.replace(/\r\n/g, "\n").split("\n");
        const lineIndex = Math.max(0, Math.min(lines.length - 1, Math.round(Number(line) - 1)));
        const targetLine = lines[lineIndex] ?? "";
        const colIndex = Math.max(0, Math.min(targetLine.length, Math.round(Number(column || 1) - 1)));
        const left = targetLine.slice(0, colIndex).match(/[A-Za-z_$][\w$]*$/)?.[0] ?? "";
        const right = targetLine.slice(colIndex).match(/^[A-Za-z_$][\w$]*/)?.[0] ?? "";
        symbol = `${left}${right}`.trim();
      }

      if (!symbol) {
        throw new Error("symbol is required for action=definition");
      }

      const matches = await this.grepFiles({
        pattern: `\\b${escapeRegExp(symbol)}\\b`,
        path: ".",
        recursive: true,
        regex: true,
        case_sensitive: true,
        max_matches: maxResults
      });

      return {
        ok: true,
        action: mode,
        provider: "builtin-lite",
        symbol,
        definitions: matches.matches,
        count: matches.count,
        truncated: matches.truncated
      };
    }

    if (mode === "diagnostics") {
      if (!rawPath || typeof rawPath !== "string") {
        throw new Error("path is required for action=diagnostics");
      }
      const ext = path.extname(String(rawPath)).toLowerCase();
      const diagnostics = [];

      if (ext === ".json") {
        const absolute = this.resolveWithinBase(rawPath);
        try {
          JSON.parse(await fs.readFile(absolute, "utf8"));
        } catch (error) {
          diagnostics.push({
            severity: "error",
            message: error.message
          });
        }
      } else if ([".js", ".mjs", ".cjs"].includes(ext)) {
        const check = await this.runNodeSyntaxCheck(rawPath);
        if (!check.ok) {
          diagnostics.push({
            severity: "error",
            message: check.message || "syntax check failed"
          });
        }
      } else {
        diagnostics.push({
          severity: "info",
          message: `diagnostics not implemented for extension '${ext || "unknown"}'`
        });
      }

      return {
        ok: true,
        action: mode,
        provider: "builtin-lite",
        path: String(rawPath),
        diagnostics,
        count: diagnostics.length
      };
    }

    throw new Error(`unsupported lsp action: ${mode}`);
  }

  async executeQuestion({ questions } = {}) {
    if (!Array.isArray(questions) || questions.length === 0) {
      throw new Error("questions must be a non-empty array");
    }

    const normalizedQuestions = questions.map((item, index) => ({
      id: String(item?.id ?? `q_${index + 1}`).trim() || `q_${index + 1}`,
      header: String(item?.header ?? "").trim(),
      question: String(item?.question ?? "").trim(),
      multiple: item?.multiple === true,
      options: Array.isArray(item?.options)
        ? item.options
            .map((option) => ({
              label: String(option?.label ?? "").trim(),
              description: String(option?.description ?? "").trim()
            }))
            .filter((option) => option.label)
        : []
    }));

    if (!this.questionHandler) {
      return {
        ok: false,
        pending: true,
        error: "question handler not configured",
        questions: normalizedQuestions
      };
    }

    const response = await this.questionHandler({
      questions: normalizedQuestions
    });

    const answers =
      Array.isArray(response?.answers) && response.answers.length
        ? response.answers
        : normalizedQuestions.map((item) => ({
            id: item.id,
            answers: []
          }));

    const summary = answers
      .map((item) => {
        const values = Array.isArray(item.answers) ? item.answers : [];
        return `${item.id}=${values.join("|") || "(none)"}`;
      })
      .join(", ");

    return {
      ok: true,
      questions: normalizedQuestions,
      answers,
      summary
    };
  }

  async executeTodoWrite({ todos, merge = false, clear = false } = {}) {
    if (clear) {
      this.todoItems = [];
      return {
        ok: true,
        count: 0,
        todos: []
      };
    }

    const normalized = Array.isArray(todos)
      ? todos.map((item, index) => normalizeTodoItem(item, index)).filter(Boolean)
      : [];

    if (!merge) {
      this.todoItems = normalized;
    } else {
      const next = new Map(this.todoItems.map((item) => [item.id, item]));
      for (const item of normalized) {
        next.set(item.id, item);
      }
      this.todoItems = [...next.values()];
    }

    return {
      ok: true,
      count: this.todoItems.length,
      todos: this.todoItems
    };
  }

  async executeTodoRead() {
    return {
      ok: true,
      count: this.todoItems.length,
      todos: this.todoItems
    };
  }

  async executeSkill({ name, path: rawPath, query, max_lines } = {}) {
    let targetPath = "";
    if (typeof rawPath === "string" && rawPath.trim()) {
      targetPath = this.resolveWithinBase(rawPath.trim());
    } else {
      const entries = await this.walkEntries(this.baseDir, true);
      const skillFiles = entries.entries
        .filter((entry) => entry.type === "file" && path.basename(entry.path).toLowerCase() === "skill.md")
        .map((entry) => this.resolveWithinBase(entry.path));

      if (skillFiles.length === 0) {
        return {
          ok: false,
          error: "no SKILL.md files found in workspace"
        };
      }

      if (typeof name === "string" && name.trim()) {
        const needle = name.trim().toLowerCase();
        const matched = skillFiles.find((filePath) => {
          const dirName = path.basename(path.dirname(filePath)).toLowerCase();
          return dirName.includes(needle) || toToolName(dirName) === toToolName(needle);
        });
        targetPath = matched ?? skillFiles[0];
      } else {
        targetPath = skillFiles[0];
      }
    }

    const content = await fs.readFile(targetPath, "utf8");
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    const maxLines = Number.isFinite(Number(max_lines)) ? Math.max(1, Math.min(2000, Number(max_lines))) : 200;
    const excerptLines = lines.slice(0, maxLines);
    const queryText = String(query ?? "").trim().toLowerCase();
    const matched_lines = queryText
      ? lines
          .map((line, index) => ({ line: index + 1, text: line }))
          .filter((item) => item.text.toLowerCase().includes(queryText))
          .slice(0, 80)
      : [];

    return {
      ok: true,
      skill: {
        name: path.basename(path.dirname(targetPath)),
        path: path.relative(this.baseDir, targetPath)
      },
      lines: lines.length,
      excerpt: excerptLines.join("\n"),
      matched_lines
    };
  }

  async executeTask({ prompt, max_tool_rounds } = {}) {
    const text = String(prompt ?? "").trim();
    if (!text) {
      throw new Error("prompt is required");
    }
    if (!this.taskRunner) {
      return {
        ok: false,
        error: "task runner is not configured"
      };
    }
    const maxRounds = parseMaxToolRounds(max_tool_rounds, Infinity);
    return this.taskRunner({
      prompt: text,
      max_tool_rounds: maxRounds
    });
  }

  async executeBatch({ calls, parallel = true, continue_on_error = true } = {}) {
    if (!Array.isArray(calls) || calls.length === 0) {
      throw new Error("calls must be a non-empty array");
    }

    const invoke = async (entry, index) => {
      const name = String(entry?.name ?? entry?.tool ?? entry?.function?.name ?? "").trim();
      if (!name) {
        return {
          index,
          ok: false,
          error: "call is missing tool name"
        };
      }
      const rawArgs = entry?.arguments ?? entry?.input ?? entry?.function?.arguments ?? {};
      const args =
        typeof rawArgs === "string"
          ? safeJsonParse(rawArgs)
          : rawArgs && typeof rawArgs === "object"
            ? rawArgs
            : {};

      try {
        const result = await this.executeToolByName(name, args, {
          disableTaskTool: true
        });
        return {
          index,
          ok: true,
          name,
          result
        };
      } catch (error) {
        return {
          index,
          ok: false,
          name,
          error: error.message
        };
      }
    };

    let results = [];
    if (parallel) {
      results = await Promise.all(calls.map((entry, index) => invoke(entry, index)));
    } else {
      for (let i = 0; i < calls.length; i += 1) {
        const result = await invoke(calls[i], i);
        results.push(result);
        if (!continue_on_error && !result.ok) {
          break;
        }
      }
    }

    const failed = results.filter((item) => !item.ok).length;
    return {
      ok: failed === 0,
      parallel: !!parallel,
      continue_on_error: !!continue_on_error,
      total: results.length,
      failed,
      succeeded: Math.max(0, results.length - failed),
      results
    };
  }

  async executePlanEnter({ goal, steps = [] } = {}) {
    const resolvedGoal = String(goal ?? "").trim();
    if (!resolvedGoal) {
      throw new Error("goal is required");
    }
    const normalizedSteps = Array.isArray(steps) ? steps.map((item) => String(item ?? "").trim()).filter(Boolean) : [];
    this.planState = {
      active: true,
      goal: resolvedGoal,
      steps: normalizedSteps,
      entered_at: new Date().toISOString(),
      exited_at: null,
      summary: ""
    };
    return {
      ok: true,
      active: true,
      goal: resolvedGoal,
      steps: normalizedSteps
    };
  }

  async executePlanExit({ summary = "" } = {}) {
    this.planState = {
      ...this.planState,
      active: false,
      exited_at: new Date().toISOString(),
      summary: String(summary ?? "").trim()
    };
    return {
      ok: true,
      active: false,
      goal: this.planState.goal,
      summary: this.planState.summary
    };
  }

  normalizeToolName(name) {
    const raw = String(name ?? "").trim();
    const aliasMap = {
      ls: "list_files",
      glob: "glob_files",
      grep: "grep_files",
      read: "read_file",
      write: "write_file",
      edit: "edit_file",
      bash: "execute_shell",
      websearch: "search_web"
    };
    return aliasMap[raw] ?? raw;
  }

  async executeCustomTool(name, args) {
    await this.ensureCustomToolsLoaded();
    const normalized = this.normalizeToolName(name);
    const tool = this.customTools.get(normalized);
    if (!tool) {
      throw new Error(`Unsupported tool: ${name}`);
    }

    const ctx = {
      base_dir: this.baseDir,
      resolve_path: (value) => this.resolveWithinBase(value),
      tools: {
        execute: async (toolName, toolArgs = {}) => this.executeToolByName(toolName, toolArgs)
      }
    };

    const output = await tool.execute(args ?? {}, ctx);
    if (output && typeof output === "object") {
      return output;
    }
    return {
      ok: true,
      output: String(output ?? "")
    };
  }

  async executeToolByName(name, args = {}, options = {}) {
    const normalizedName = this.normalizeToolName(name);

    switch (normalizedName) {
      case "list_files":
        return this.listFiles(args);
      case "glob_files":
        return this.globFiles(args);
      case "grep_files":
        return this.grepFiles(args);
      case "read_file":
        return this.readFile(args);
      case "write_file":
        return this.writeFile(args);
      case "create_file":
        return this.createFile(args);
      case "edit_file":
        return this.editFile(args);
      case "replace_in_file":
        return this.replaceInFile(args);
      case "insert_in_file":
        return this.insertInFile(args);
      case "patch_file":
        return this.patchFile(args);
      case "apply_patch":
        return this.applyPatch(args);
      case "move_file":
        return this.moveFile(args);
      case "delete_file":
        return this.deleteFile(args);
      case "search_web":
        return this.searchWeb(args);
      case "execute_shell":
        return this.executeShell(args);
      case "webfetch":
        return this.executeWebFetch(args);
      case "codesearch":
        return this.executeCodeSearch(args);
      case "lsp":
        return this.executeLsp(args);
      case "question":
        return this.executeQuestion(args);
      case "todowrite":
        return this.executeTodoWrite(args);
      case "todoread":
        return this.executeTodoRead(args);
      case "skill":
        return this.executeSkill(args);
      case "batch":
        return this.executeBatch(args);
      case "task":
        if (options?.disableTaskTool) {
          return {
            ok: false,
            blocked: true,
            blocked_reason: "task tool disabled in current execution scope"
          };
        }
        return this.executeTask(args);
      case "plan_enter":
        if (options?.disablePlanTools) {
          return {
            ok: false,
            blocked: true,
            blocked_reason: "plan tools disabled in current execution scope"
          };
        }
        return this.executePlanEnter(args);
      case "plan_exit":
        if (options?.disablePlanTools) {
          return {
            ok: false,
            blocked: true,
            blocked_reason: "plan tools disabled in current execution scope"
          };
        }
        return this.executePlanExit(args);
      default:
        return this.executeCustomTool(normalizedName, args);
    }
  }

  async executeToolCall(call, options = {}) {
    const fn = call?.function;
    const name = fn?.name;
    const args = safeJsonParse(fn?.arguments);
    return this.executeToolByName(name, args, options);
  }
}
