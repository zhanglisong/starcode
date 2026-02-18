import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadProfiles, maskSecret, saveProfiles } from "../src/cli/profileStore.js";

test("saveProfiles persists secure profile and loadProfiles restores it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "starcode-profile-store-"));
  const storePath = path.join(root, ".starcode", "profiles.json");
  const data = {
    version: 1,
    auth: {
      moonshot: {
        endpoint: "https://api.moonshot.ai/v1/chat/completions",
        api_key: "sk-secret-value-123456"
      }
    },
    defaults: {
      provider: "moonshot",
      model: "kimi-k2.5"
    }
  };

  await saveProfiles(data, storePath);
  const loaded = await loadProfiles(storePath);

  assert.equal(loaded.path, storePath);
  assert.equal(loaded.data.defaults.provider, "moonshot");
  assert.equal(loaded.data.defaults.model, "kimi-k2.5");
  assert.equal(loaded.data.auth.moonshot.api_key, "sk-secret-value-123456");

  const stat = await fs.stat(storePath);
  assert.equal(stat.mode & 0o777, 0o600);
});

test("maskSecret redacts long and short keys", () => {
  assert.equal(maskSecret(""), "");
  assert.equal(maskSecret("abcdef"), "****ef");
  assert.equal(maskSecret("sk-0123456789"), "sk-...6789");
});
