const RULES = [
  {
    key: "email",
    regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    replacement: "[REDACTED_EMAIL]"
  },
  {
    key: "openaiKey",
    regex: /\bsk-[A-Za-z0-9]{16,}\b/g,
    replacement: "[REDACTED_API_KEY]"
  },
  {
    key: "anthropicKey",
    regex: /\bsk-ant-[A-Za-z0-9-]{16,}\b/g,
    replacement: "[REDACTED_API_KEY]"
  },
  {
    key: "githubToken",
    regex: /\bghp_[A-Za-z0-9]{20,}\b/g,
    replacement: "[REDACTED_GITHUB_TOKEN]"
  },
  {
    key: "awsKey",
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED_AWS_KEY]"
  },
  {
    key: "privateKey",
    regex: /-----BEGIN(?: RSA| EC| OPENSSH)? PRIVATE KEY-----[\s\S]*?-----END(?: RSA| EC| OPENSSH)? PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]"
  },
  {
    key: "bearer",
    regex: /\bBearer\s+[A-Za-z0-9._-]+/gi,
    replacement: "Bearer [REDACTED_TOKEN]"
  }
];

function ensureStatsShape(stats) {
  if (!stats || typeof stats !== "object") {
    return createRedactionStats();
  }

  if (!stats.rules || typeof stats.rules !== "object") {
    stats.rules = {};
  }

  if (!Number.isFinite(stats.total_redactions)) {
    stats.total_redactions = 0;
  }

  for (const rule of RULES) {
    if (!Number.isFinite(stats.rules[rule.key])) {
      stats.rules[rule.key] = 0;
    }
  }

  return stats;
}

function redactString(value, stats) {
  let output = value;
  const targetStats = ensureStatsShape(stats);

  for (const rule of RULES) {
    output = output.replace(rule.regex, () => {
      targetStats.total_redactions += 1;
      targetStats.rules[rule.key] += 1;
      return rule.replacement;
    });
  }

  return output;
}

export function createRedactionStats() {
  return {
    total_redactions: 0,
    rules: Object.fromEntries(RULES.map((rule) => [rule.key, 0]))
  };
}

export function summarizeRedactionStats(stats) {
  const shaped = ensureStatsShape(stats);

  return {
    total_redactions: shaped.total_redactions,
    rules: Object.entries(shaped.rules)
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
  };
}

export function redactSensitiveDataWithStats(value, stats = createRedactionStats()) {
  if (typeof value === "string") {
    return redactString(value, stats);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveDataWithStats(item, stats));
  }

  if (value && typeof value === "object") {
    const output = {};
    for (const [k, v] of Object.entries(value)) {
      output[k] = redactSensitiveDataWithStats(v, stats);
    }
    return output;
  }

  return value;
}

export function redactSensitiveData(value) {
  const stats = createRedactionStats();
  return redactSensitiveDataWithStats(value, stats);
}
