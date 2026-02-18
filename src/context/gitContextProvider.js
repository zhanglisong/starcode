import { execFile } from "node:child_process";
import path from "node:path";

function runExecFile({ command, args, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          ok: false,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          error: error.message
        });
        return;
      }

      resolve({
        ok: true,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? "")
      });
    });
  });
}

function uniqueLines(...values) {
  const output = [];
  const seen = new Set();

  for (const value of values) {
    const lines = String(value ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      if (seen.has(line)) {
        continue;
      }
      seen.add(line);
      output.push(line);
    }
  }

  return output;
}

function truncateText(text, maxChars) {
  const value = String(text ?? "");
  if (value.length <= maxChars) {
    return {
      text: value,
      truncated: false
    };
  }

  const suffix = "\n...<truncated>";
  const available = Math.max(0, maxChars - suffix.length);
  return {
    text: `${value.slice(0, available)}${suffix}`,
    truncated: true
  };
}

export class GitContextProvider {
  constructor({
    baseDir = process.cwd(),
    enabled = true,
    timeoutMs = 1500,
    maxChars = 3000,
    maxChangedFiles = 30,
    maxStatusLines = 30,
    runner
  } = {}) {
    this.baseDir = path.resolve(baseDir);
    this.enabled = !!enabled;
    this.timeoutMs = Math.max(100, Number(timeoutMs) || 1500);
    this.maxChars = Math.max(500, Number(maxChars) || 3000);
    this.maxChangedFiles = Math.max(1, Number(maxChangedFiles) || 30);
    this.maxStatusLines = Math.max(1, Number(maxStatusLines) || 30);
    this.runner = runner;
  }

  async runGit(args) {
    if (this.runner) {
      return this.runner({
        command: "git",
        args,
        cwd: this.baseDir,
        timeoutMs: this.timeoutMs
      });
    }

    return runExecFile({
      command: "git",
      args,
      cwd: this.baseDir,
      timeoutMs: this.timeoutMs
    });
  }

  async buildContext() {
    if (!this.enabled) {
      return null;
    }

    const inside = await this.runGit(["rev-parse", "--is-inside-work-tree"]);
    if (!inside.ok || inside.stdout.trim() !== "true") {
      return null;
    }

    const [branchResult, statusResult, stagedNames, unstagedNames, stagedStat, unstagedStat] = await Promise.all([
      this.runGit(["rev-parse", "--abbrev-ref", "HEAD"]),
      this.runGit(["status", "--short", "--branch"]),
      this.runGit(["diff", "--cached", "--name-only"]),
      this.runGit(["diff", "--name-only"]),
      this.runGit(["diff", "--cached", "--stat"]),
      this.runGit(["diff", "--stat"])
    ]);

    const branch = (branchResult.stdout || "").trim() || "unknown";
    const changedFiles = uniqueLines(stagedNames.stdout, unstagedNames.stdout).slice(0, this.maxChangedFiles);

    const lines = [
      "Git workspace context:",
      `- branch: ${branch}`,
      `- changed_files: ${changedFiles.length}`
    ];

    if (statusResult.ok && statusResult.stdout.trim()) {
      lines.push("- status:");
      for (const line of statusResult.stdout.trim().split("\n").slice(0, this.maxStatusLines)) {
        lines.push(`  ${line}`);
      }
    }

    if (changedFiles.length) {
      lines.push("- files:");
      for (const file of changedFiles) {
        lines.push(`  ${file}`);
      }
    }

    const statLines = [];
    if (stagedStat.ok && stagedStat.stdout.trim()) {
      statLines.push("staged diff stat:", stagedStat.stdout.trim());
    }
    if (unstagedStat.ok && unstagedStat.stdout.trim()) {
      statLines.push("unstaged diff stat:", unstagedStat.stdout.trim());
    }

    if (statLines.length) {
      lines.push("- diff_stat:");
      for (const line of statLines.join("\n").split("\n").slice(0, this.maxStatusLines)) {
        lines.push(`  ${line}`);
      }
    }

    const { text, truncated } = truncateText(lines.join("\n"), this.maxChars);

    return {
      source: "git",
      branch,
      changed_files: changedFiles.length,
      truncated,
      content: text
    };
  }
}
