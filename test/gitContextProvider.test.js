import test from "node:test";
import assert from "node:assert/strict";
import { GitContextProvider } from "../src/context/gitContextProvider.js";

function runnerFromMap(map) {
  return async ({ args }) => {
    const key = args.join(" ");
    if (!(key in map)) {
      return { ok: false, stdout: "", stderr: "missing" };
    }
    const value = map[key];
    if (typeof value === "string") {
      return { ok: true, stdout: value, stderr: "" };
    }
    return value;
  };
}

test("buildContext returns null when not inside a git worktree", async () => {
  const provider = new GitContextProvider({
    runner: runnerFromMap({
      "rev-parse --is-inside-work-tree": "false\n"
    })
  });

  const result = await provider.buildContext();
  assert.equal(result, null);
});

test("buildContext produces bounded git context text", async () => {
  const provider = new GitContextProvider({
    maxChars: 520,
    maxChangedFiles: 2,
    runner: runnerFromMap({
      "rev-parse --is-inside-work-tree": "true\n",
      "rev-parse --abbrev-ref HEAD": "feature/sc-005\n",
      "status --short --branch": "## feature/sc-005\n M src/a.js\n M src/b.js\n",
      "diff --cached --name-only": "src/a.js\n",
      "diff --name-only": "src/a.js\nsrc/b.js\nsrc/c.js\n",
      "diff --cached --stat": " src/a.js | 3 ++-\n 1 file changed, 2 insertions(+), 1 deletion(-)\n",
      "diff --stat": " src/b.js | 2 +-\n src/c.js | 1 +\n 2 files changed, 2 insertions(+), 1 deletion(-)\n"
    })
  });

  const context = await provider.buildContext();
  assert.equal(typeof context, "object");
  assert.equal(context.source, "git");
  assert.equal(context.branch, "feature/sc-005");
  assert.equal(context.changed_files, 2);
  assert.equal(context.content.includes("Git workspace context:"), true);
  assert.equal(context.content.includes("src/a.js"), true);
  assert.equal(context.content.includes("src/b.js"), true);
  assert.equal(context.content.length <= 520, true);
});
