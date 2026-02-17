import fs from "node:fs/promises";
import path from "node:path";

export class ModelIoLogger {
  constructor({
    enabled = false,
    filePath = ".telemetry/model-io.jsonl"
  } = {}) {
    this.enabled = enabled;
    this.filePath = filePath;
    this.ready = false;
  }

  async ensureReady() {
    if (!this.enabled || this.ready) {
      return;
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    this.ready = true;
  }

  async log(event) {
    if (!this.enabled) {
      return;
    }

    try {
      await this.ensureReady();
      const payload = {
        ts: new Date().toISOString(),
        ...event
      };
      await fs.appendFile(this.filePath, `${JSON.stringify(payload)}\n`, "utf8");
    } catch {
      // Debug logging should never break the agent flow.
    }
  }
}
