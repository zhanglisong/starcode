import path from "node:path";
import { SessionStore } from "../session/store.js";

function parseArgs(args) {
  const positionals = [];
  const flags = {};

  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i] ?? "");
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = String(args[i + 1] ?? "");
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }

  return {
    positionals,
    flags
  };
}

function print(output, line) {
  output.write(`${line}\n`);
}

function resolveSessionDir({ workspaceDir = process.cwd(), sessionDir = "" } = {}) {
  const selected = sessionDir || ".telemetry/sessions";
  return path.isAbsolute(selected) ? selected : path.resolve(workspaceDir, selected);
}

export async function runSessionCommand(args, { output = process.stdout, workspaceDir = process.cwd(), sessionDir = "" } = {}) {
  const [subcommand = "list", ...rest] = args;
  const command = String(subcommand).toLowerCase();
  const parsed = parseArgs(rest);
  const dir = resolveSessionDir({ workspaceDir, sessionDir });
  const store = new SessionStore({ baseDir: dir });

  if (command === "list") {
    const sessions = await store.list();
    print(output, `session_dir=${dir}`);
    print(output, `sessions=${sessions.length}`);
    for (const session of sessions) {
      print(
        output,
        `- ${session.id} parent=${session.parent_session_id ?? "-"} turns=${session.turns} messages=${session.messages} updated=${session.updated_at}`
      );
    }
    return true;
  }

  if (command === "delete") {
    const id = String(parsed.positionals[0] ?? "").trim();
    if (!id) {
      throw new Error("Missing session id. Usage: starcode session delete <id>");
    }
    await store.delete(id);
    print(output, `session delete ok id=${id}`);
    return true;
  }

  if (command === "fork") {
    const sourceId = String(parsed.positionals[0] ?? "").trim();
    if (!sourceId) {
      throw new Error("Missing source session id. Usage: starcode session fork <id> [--session <new_id>]");
    }
    const targetId = String(parsed.flags.session ?? parsed.flags.id ?? "").trim();
    const forked = await store.fork(sourceId, {
      id: targetId || undefined
    });
    print(output, `session fork ok source=${sourceId} id=${forked.id} parent=${forked.parent_session_id ?? "-"}`);
    return true;
  }

  throw new Error(`Unknown session subcommand '${subcommand}'. Use: list | delete | fork`);
}
