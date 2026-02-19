import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { normalizeRule } from "./policyEngine.js";

function defaultFilePath() {
  return path.join(os.homedir(), ".starcode", "permissions.json");
}

function emptyState() {
  return {
    version: 1,
    rules: []
  };
}

export class RuntimeApprovalStore {
  constructor({ filePath = "", autoLoad = true } = {}) {
    this.filePath = filePath ? path.resolve(filePath) : defaultFilePath();
    this.state = emptyState();
    this.ready = false;
    this.autoLoad = autoLoad;
  }

  async ensureLoaded() {
    if (this.ready) {
      return;
    }

    if (!this.autoLoad) {
      this.ready = true;
      return;
    }

    await this.load();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const rules = Array.isArray(parsed?.rules) ? parsed.rules.map((rule) => normalizeRule(rule)) : [];
      this.state = {
        version: 1,
        rules
      };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      this.state = emptyState();
    }
    this.ready = true;
    return this.state;
  }

  async persist() {
    await this.ensureLoaded();
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    try {
      await fs.chmod(this.filePath, 0o600);
    } catch {
      // Best effort only.
    }
  }

  async getRules() {
    await this.ensureLoaded();
    return [...this.state.rules];
  }

  async upsertRule(rule) {
    await this.ensureLoaded();
    const normalized = normalizeRule(rule);
    const index = this.state.rules.findIndex(
      (item) => item.permission === normalized.permission && item.pattern === normalized.pattern
    );

    if (index >= 0) {
      this.state.rules[index] = normalized;
    } else {
      this.state.rules.push(normalized);
    }

    await this.persist();
    return normalized;
  }

  async upsertRules(rules = []) {
    for (const rule of rules) {
      await this.upsertRule(rule);
    }
    return this.getRules();
  }
}
