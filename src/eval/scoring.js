import fs from "node:fs/promises";
import path from "node:path";

function normalizeText(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

async function readFileSafe(filePath) {
  try {
    const body = await fs.readFile(filePath, "utf8");
    return { ok: true, content: body };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ok: false, content: null };
    }
    throw error;
  }
}

async function evaluateCheck({ check, workspaceDir, assistantText, toolResults }) {
  switch (check.type) {
    case "file_equals": {
      const absolute = path.resolve(workspaceDir, check.path);
      const actual = await readFileSafe(absolute);
      const passed = actual.ok && normalizeText(actual.content) === normalizeText(check.expected);
      return {
        type: check.type,
        passed,
        detail: passed
          ? `File ${check.path} matched expected content.`
          : `File ${check.path} did not match expected content.`
      };
    }
    case "file_not_exists": {
      const absolute = path.resolve(workspaceDir, check.path);
      const actual = await readFileSafe(absolute);
      const passed = !actual.ok;
      return {
        type: check.type,
        passed,
        detail: passed ? `File ${check.path} is absent as expected.` : `File ${check.path} exists unexpectedly.`
      };
    }
    case "response_contains": {
      const haystack = normalizeText(assistantText).toLowerCase();
      const needle = normalizeText(check.expected).toLowerCase();
      const passed = haystack.includes(needle);
      return {
        type: check.type,
        passed,
        detail: passed
          ? `Assistant response contains '${check.expected}'.`
          : `Assistant response does not contain '${check.expected}'.`
      };
    }
    case "response_contains_any": {
      const haystack = normalizeText(assistantText).toLowerCase();
      const expectedAny = Array.isArray(check.expectedAny) ? check.expectedAny : [];
      const passed = expectedAny.some((needle) => haystack.includes(normalizeText(needle).toLowerCase()));
      return {
        type: check.type,
        passed,
        detail: passed
          ? `Assistant response matched one expected phrase.`
          : `Assistant response matched none of the expected phrases.`
      };
    }
    case "min_tool_calls": {
      const count = Array.isArray(toolResults) ? toolResults.length : 0;
      const min = Number(check.min ?? 0);
      const passed = count >= min;
      return {
        type: check.type,
        passed,
        detail: passed ? `Observed ${count} tool calls (min ${min}).` : `Observed ${count} tool calls (min ${min}).`
      };
    }
    default:
      return {
        type: check.type,
        passed: false,
        detail: `Unsupported check type: ${check.type}`
      };
  }
}

export async function scoreTask({ task, workspaceDir, assistantText, toolResults }) {
  const checks = task.checks ?? [];
  const results = [];

  for (const check of checks) {
    results.push(await evaluateCheck({ check, workspaceDir, assistantText, toolResults }));
  }

  const passedChecks = results.filter((item) => item.passed).length;
  const maxChecks = results.length;

  return {
    passed: passedChecks === maxChecks,
    passedChecks,
    maxChecks,
    checks: results
  };
}
