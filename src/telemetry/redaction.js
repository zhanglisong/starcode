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

function redactString(value) {
  let output = value;
  for (const rule of RULES) {
    output = output.replace(rule.regex, rule.replacement);
  }
  return output;
}

export function redactSensitiveData(value) {
  if (typeof value === "string") {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveData(item));
  }

  if (value && typeof value === "object") {
    const output = {};
    for (const [k, v] of Object.entries(value)) {
      output[k] = redactSensitiveData(v);
    }
    return output;
  }

  return value;
}
