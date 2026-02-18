import fs from "node:fs/promises";
import path from "node:path";

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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toPosixPath(value) {
  return String(value).split(path.sep).join("/");
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
    maxGrepMatches = 200
  } = {}) {
    this.baseDir = path.resolve(baseDir);
    this.maxReadBytes = maxReadBytes;
    this.maxListEntries = maxListEntries;
    this.maxGrepMatches = maxGrepMatches;
  }

  getToolDefinitions() {
    return [
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
      }
    ];
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

  async executeToolCall(call) {
    const fn = call?.function;
    const name = fn?.name;
    const args = safeJsonParse(fn?.arguments);

    switch (name) {
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
      case "move_file":
        return this.moveFile(args);
      case "delete_file":
        return this.deleteFile(args);
      default:
        throw new Error(`Unsupported tool: ${name}`);
    }
  }
}
