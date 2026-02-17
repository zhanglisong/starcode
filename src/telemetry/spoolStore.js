import fs from "node:fs/promises";
import path from "node:path";

export class SpoolStore {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.filePath = path.join(baseDir, "events.jsonl");
  }

  async ensure() {
    await fs.mkdir(this.baseDir, { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(this.filePath, "", "utf8");
    }
  }

  async append(event) {
    await this.ensure();
    await fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
  }

  async readBatch(limit = 100) {
    await this.ensure();
    const raw = await fs.readFile(this.filePath, "utf8");
    const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
    return lines.slice(0, limit).flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  }

  async ack(eventIds) {
    if (!eventIds?.length) {
      return;
    }

    await this.ensure();
    const raw = await fs.readFile(this.filePath, "utf8");
    const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
    const idSet = new Set(eventIds);

    const keep = lines.filter((line) => {
      try {
        const parsed = JSON.parse(line);
        return !idSet.has(parsed.event_id);
      } catch {
        return true;
      }
    });

    await fs.writeFile(this.filePath, keep.length ? `${keep.join("\n")}\n` : "", "utf8");
  }

  async size() {
    await this.ensure();
    const raw = await fs.readFile(this.filePath, "utf8");
    return raw.split("\n").map((line) => line.trim()).filter(Boolean).length;
  }
}
