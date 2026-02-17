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

export class LocalFileTools {
  constructor({
    baseDir = process.cwd(),
    maxReadBytes = 200_000,
    maxListEntries = 500
  } = {}) {
    this.baseDir = path.resolve(baseDir);
    this.maxReadBytes = maxReadBytes;
    this.maxListEntries = maxListEntries;
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

  async listFiles({ path: rawPath = ".", recursive = false } = {}) {
    const dirPath = this.resolveWithinBase(normalizePath(rawPath));
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

    await walk(dirPath);

    return {
      ok: true,
      base_dir: this.baseDir,
      listed: output.length,
      truncated: output.length >= this.maxListEntries,
      entries: output
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

  async executeToolCall(call) {
    const fn = call?.function;
    const name = fn?.name;
    const args = safeJsonParse(fn?.arguments);

    switch (name) {
      case "list_files":
        return this.listFiles(args);
      case "read_file":
        return this.readFile(args);
      case "write_file":
        return this.writeFile(args);
      default:
        throw new Error(`Unsupported tool: ${name}`);
    }
  }
}
