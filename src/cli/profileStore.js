import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function defaultStorePath() {
  return path.join(os.homedir(), ".starcode", "profiles.json");
}

function emptyProfile() {
  return {
    version: 1,
    auth: {},
    defaults: {
      provider: "",
      model: ""
    },
    mcp: {
      servers: {},
      auth: {}
    },
    permission: {
      rules: []
    }
  };
}

export function resolveProfilePath(overridePath = "") {
  if (overridePath && typeof overridePath === "string") {
    return path.resolve(overridePath);
  }
  if (process.env.STARCODE_PROFILE_PATH) {
    return path.resolve(process.env.STARCODE_PROFILE_PATH);
  }
  return defaultStorePath();
}

export async function loadProfiles(storePathInput = "") {
  const storePath = resolveProfilePath(storePathInput);

  try {
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      path: storePath,
      data: {
        ...emptyProfile(),
        ...parsed,
        auth: parsed?.auth && typeof parsed.auth === "object" ? parsed.auth : {},
        defaults:
          parsed?.defaults && typeof parsed.defaults === "object"
            ? {
                provider: String(parsed.defaults.provider ?? ""),
                model: String(parsed.defaults.model ?? "")
              }
            : { provider: "", model: "" },
        mcp:
          parsed?.mcp && typeof parsed.mcp === "object"
            ? {
                servers: parsed.mcp?.servers && typeof parsed.mcp.servers === "object" ? parsed.mcp.servers : {},
                auth: parsed.mcp?.auth && typeof parsed.mcp.auth === "object" ? parsed.mcp.auth : {}
              }
            : { servers: {}, auth: {} },
        permission:
          parsed?.permission && typeof parsed.permission === "object"
            ? {
                rules: Array.isArray(parsed.permission?.rules) ? parsed.permission.rules : []
              }
            : { rules: [] }
      }
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        path: storePath,
        data: emptyProfile()
      };
    }
    throw error;
  }
}

export function maskSecret(secret = "") {
  const value = String(secret ?? "");
  if (!value) {
    return "";
  }
  if (value.length <= 8) {
    return `${"*".repeat(Math.max(0, value.length - 2))}${value.slice(-2)}`;
  }
  return `${value.slice(0, 3)}...${value.slice(-4)}`;
}

async function ensureSecureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(dirPath, 0o700);
  } catch {
    // best effort on platforms that ignore chmod
  }
}

export async function saveProfiles(data, storePathInput = "") {
  const storePath = resolveProfilePath(storePathInput);
  await ensureSecureDir(path.dirname(storePath));
  await fs.writeFile(storePath, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  try {
    await fs.chmod(storePath, 0o600);
  } catch {
    // best effort on platforms that ignore chmod
  }
  return storePath;
}
