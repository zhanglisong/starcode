function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wildcardToRegExp(pattern) {
  const escaped = escapeRegExp(String(pattern ?? "*"))
    .replace(/\\\*/g, ".*")
    .replace(/\\\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function normalizeAction(action) {
  const value = String(action ?? "ask").toLowerCase();
  if (value === "allow" || value === "deny" || value === "ask") {
    return value;
  }
  return "ask";
}

export function normalizeRule(rule = {}) {
  return {
    permission: String(rule.permission ?? "*").trim() || "*",
    pattern: String(rule.pattern ?? "*").trim() || "*",
    action: normalizeAction(rule.action),
    source: String(rule.source ?? "runtime"),
    updated_at: rule.updated_at ?? new Date().toISOString()
  };
}

export function matchRule(rule, permission, pattern) {
  const permissionRegex = wildcardToRegExp(rule.permission);
  const patternRegex = wildcardToRegExp(rule.pattern);
  return permissionRegex.test(String(permission ?? "")) && patternRegex.test(String(pattern ?? ""));
}

export function evaluateRuleSet({ permission, pattern, rules = [] } = {}) {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = normalizeRule(rules[index]);
    if (matchRule(rule, permission, pattern)) {
      return {
        action: rule.action,
        rule
      };
    }
  }

  return {
    action: "ask",
    rule: null
  };
}

export function evaluatePatterns({ permission, patterns = [], rules = [] } = {}) {
  const values = Array.isArray(patterns) && patterns.length ? patterns : ["*"];
  const results = values.map((pattern) => ({
    pattern,
    ...evaluateRuleSet({
      permission,
      pattern,
      rules
    })
  }));

  if (results.some((item) => item.action === "deny")) {
    return {
      action: "deny",
      results
    };
  }

  if (results.some((item) => item.action === "ask")) {
    return {
      action: "ask",
      results
    };
  }

  return {
    action: "allow",
    results
  };
}

export function defaultPermissionRules() {
  return [
    normalizeRule({
      permission: "read",
      pattern: "*",
      action: "allow",
      source: "default"
    }),
    normalizeRule({
      permission: "web",
      pattern: "*",
      action: "allow",
      source: "default"
    }),
    normalizeRule({
      permission: "edit",
      pattern: "*",
      action: "ask",
      source: "default"
    }),
    normalizeRule({
      permission: "bash",
      pattern: "*",
      action: "ask",
      source: "default"
    }),
    normalizeRule({
      permission: "mcp",
      pattern: "*",
      action: "ask",
      source: "default"
    }),
    normalizeRule({
      permission: "tool",
      pattern: "*",
      action: "ask",
      source: "default"
    })
  ];
}
