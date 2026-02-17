import test from "node:test";
import assert from "node:assert/strict";
import { redactSensitiveData } from "../src/telemetry/redaction.js";

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
