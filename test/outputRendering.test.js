import test from "node:test";
import assert from "node:assert/strict";
import { shouldRenderFinalOutputAfterStreaming } from "../src/cli/outputRendering.js";

test("render final output when stream is empty", () => {
  assert.equal(
    shouldRenderFinalOutputAfterStreaming({
      streamedText: "",
      finalText: "Tool-call round limit reached before final response."
    }),
    true
  );
});

test("skip final output when stream equals final output", () => {
  assert.equal(
    shouldRenderFinalOutputAfterStreaming({
      streamedText: "Done.",
      finalText: "Done."
    }),
    false
  );
});

test("skip final output when stream already ends with final output", () => {
  assert.equal(
    shouldRenderFinalOutputAfterStreaming({
      streamedText: "Working...\nDone.",
      finalText: "Done."
    }),
    false
  );
});

test("render final output when stream does not include final output suffix", () => {
  assert.equal(
    shouldRenderFinalOutputAfterStreaming({
      streamedText: "I'll search the repository now.",
      finalText: "Tool-call round limit reached before final response."
    }),
    true
  );
});

test("skip final output when final text is empty", () => {
  assert.equal(
    shouldRenderFinalOutputAfterStreaming({
      streamedText: "Partial stream",
      finalText: ""
    }),
    false
  );
});
