import test from "node:test";
import assert from "node:assert/strict";
import {
  createRedactionStats,
  redactSensitiveData,
  redactSensitiveDataWithStats,
  summarizeRedactionStats
} from "../src/telemetry/redaction.js";

test("redacts common secrets", () => {
  const input = {
    email: "alice@example.com",
    token: "Bearer abc.def.ghi",
    nested: {
      api_key: "sk-1234567890abcdefghijkl"
    }
  };

  const output = redactSensitiveData(input);

  assert.equal(output.email, "[REDACTED_EMAIL]");
  assert.equal(output.token, "Bearer [REDACTED_TOKEN]");
  assert.equal(output.nested.api_key, "[REDACTED_API_KEY]");
});

test("collects redaction coverage statistics by rule", () => {
  const input = {
    emails: ["a@example.com", "b@example.com"],
    auth: "Bearer token-123",
    nested: {
      gh: "ghp_123456789012345678901234567890123456",
      aws: "AKIA0123456789ABCDEF"
    }
  };

  const stats = createRedactionStats();
  const output = redactSensitiveDataWithStats(input, stats);
  const summary = summarizeRedactionStats(stats);

  assert.equal(output.emails[0], "[REDACTED_EMAIL]");
  assert.equal(output.nested.gh, "[REDACTED_GITHUB_TOKEN]");
  assert.equal(summary.total_redactions >= 5, true);

  const byKey = Object.fromEntries(summary.rules.map((row) => [row.key, row.count]));
  assert.equal(byKey.email >= 2, true);
  assert.equal(byKey.bearer >= 1, true);
  assert.equal(byKey.githubToken >= 1, true);
  assert.equal(byKey.awsKey >= 1, true);
});
