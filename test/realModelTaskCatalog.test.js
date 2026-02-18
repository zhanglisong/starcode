import test from "node:test";
import assert from "node:assert/strict";
import { realModelRegressionTasks } from "../src/eval/realModelTaskCatalog.js";

test("real model regression task catalog has expected breadth", () => {
  assert.equal(Array.isArray(realModelRegressionTasks), true);
  assert.equal(realModelRegressionTasks.length >= 12, true);

  const ids = new Set(realModelRegressionTasks.map((task) => task.id));
  assert.equal(ids.size, realModelRegressionTasks.length);

  const categories = new Set(realModelRegressionTasks.map((task) => task.category));
  assert.equal(categories.has("streaming"), true);
  assert.equal(categories.has("planning"), true);
  assert.equal(categories.has("memory"), true);
  assert.equal(categories.has("contracts"), true);
});
