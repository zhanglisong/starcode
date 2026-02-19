import { parseMcpToolName } from "../mcp/mcpManager.js";
import { collectPatchPaths } from "../tools/patchParser.js";

function safeParseArguments(raw) {
  if (typeof raw !== "string") {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function toPattern(value, fallback = "*") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function pathPatterns(args, keys) {
  const output = [];
  for (const key of keys) {
    const value = args?.[key];
    if (typeof value === "string" && value.trim()) {
      output.push(value.trim());
    }
  }
  return output.length ? output : ["*"];
}

export function resolveToolPermissionRequest(call) {
  const name = String(call?.function?.name ?? "");
  const args = safeParseArguments(call?.function?.arguments);
  const mcp = parseMcpToolName(name);

  if (mcp) {
    return {
      permission: "mcp",
      patterns: [`${mcp.serverId}/${mcp.toolName}`],
      always: [`${mcp.serverId}/*`],
      metadata: {
        tool_name: name,
        server_id: mcp.serverId,
        mcp_tool_name: mcp.toolName
      }
    };
  }

  if (["list_files", "glob_files", "grep_files", "read_file"].includes(name)) {
    return {
      permission: "read",
      patterns: pathPatterns(args, ["path"]),
      always: ["*"],
      metadata: {
        tool_name: name
      }
    };
  }

  if (name === "execute_shell") {
    return {
      permission: "bash",
      patterns: [toPattern(args?.command, "*")],
      always: ["*"],
      metadata: {
        tool_name: name,
        command: toPattern(args?.command, "")
      }
    };
  }

  if (name === "search_web") {
    return {
      permission: "web",
      patterns: [toPattern(args?.query, "*")],
      always: ["*"],
      metadata: {
        tool_name: name
      }
    };
  }

  if (name === "apply_patch") {
    const patchText = String(args?.patch ?? args?.patch_text ?? args?.patchText ?? "");
    let patterns = ["*"];
    if (patchText.trim()) {
      try {
        const paths = collectPatchPaths(patchText);
        if (paths.length) {
          patterns = paths;
        }
      } catch {
        // Keep wildcard if patch parse fails; tool execution will report parser errors later.
      }
    }
    return {
      permission: "edit",
      patterns,
      always: ["*"],
      metadata: {
        tool_name: name
      }
    };
  }

  if (
    [
      "write_file",
      "create_file",
      "edit_file",
      "replace_in_file",
      "insert_in_file",
      "patch_file",
      "move_file",
      "delete_file"
    ].includes(name)
  ) {
    const patterns =
      name === "move_file"
        ? pathPatterns(args, ["from", "to"])
        : pathPatterns(args, ["path"]);

    return {
      permission: "edit",
      patterns,
      always: ["*"],
      metadata: {
        tool_name: name
      }
    };
  }

  return {
    permission: "tool",
    patterns: [name || "*"],
    always: ["*"],
    metadata: {
      tool_name: name || "unknown"
    }
  };
}
