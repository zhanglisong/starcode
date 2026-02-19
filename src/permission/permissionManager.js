import { defaultPermissionRules, evaluatePatterns, normalizeRule } from "./policyEngine.js";
import { resolveToolPermissionRequest } from "./toolPermissions.js";

export class PermissionManager {
  constructor({
    store = null,
    rules = [],
    onAsk = null,
    disabled = false
  } = {}) {
    this.store = store;
    this.onAsk = typeof onAsk === "function" ? onAsk : null;
    this.disabled = !!disabled;
    this.sessionRules = (Array.isArray(rules) ? rules : []).map((rule) => normalizeRule(rule));
    this.defaultRules = defaultPermissionRules();
  }

  async getAllRules() {
    const persisted = this.store ? await this.store.getRules() : [];
    return [...this.defaultRules, ...persisted, ...this.sessionRules];
  }

  async persistAlwaysRule({ permission, pattern }) {
    const rule = normalizeRule({
      permission,
      pattern,
      action: "allow",
      source: "always"
    });
    this.sessionRules.push(rule);
    if (this.store) {
      await this.store.upsertRule(rule);
    }
    return rule;
  }

  async authorizeToolCall(call, context = {}) {
    if (this.disabled) {
      return {
        allowed: true,
        decision: "allow",
        source: "disabled",
        mode: "disabled",
        request: null,
        prompt_decision: null
      };
    }

    const request = resolveToolPermissionRequest(call);
    const rules = await this.getAllRules();
    const evaluated = evaluatePatterns({
      permission: request.permission,
      patterns: request.patterns,
      rules
    });

    if (evaluated.action === "allow") {
      return {
        allowed: true,
        decision: "allow",
        source: "rule",
        mode: "rule",
        request,
        matched: evaluated.results
      };
    }

    if (evaluated.action === "deny") {
      const denied = evaluated.results.find((item) => item.action === "deny");
      return {
        allowed: false,
        decision: "deny",
        source: "rule",
        mode: "rule",
        request,
        matched: evaluated.results,
        reason: "blocked_by_rule",
        denied_rule: denied?.rule ?? null
      };
    }

    if (!this.onAsk) {
      return {
        allowed: false,
        decision: "deny",
        source: "policy",
        mode: "ask_unavailable",
        request,
        matched: evaluated.results,
        reason: "approval_required_but_no_prompt_handler"
      };
    }

    const promptDecisionRaw = await this.onAsk({
      ...context,
      request,
      matched: evaluated.results
    });
    const promptDecision = String(promptDecisionRaw?.reply ?? "reject").toLowerCase();
    const promptMessage = String(promptDecisionRaw?.message ?? "").trim();

    if (promptDecision === "once") {
      return {
        allowed: true,
        decision: "allow",
        source: "prompt",
        mode: "once",
        request,
        matched: evaluated.results,
        prompt_decision: {
          reply: "once",
          message: promptMessage
        }
      };
    }

    if (promptDecision === "always") {
      const patterns = Array.isArray(request.always) && request.always.length ? request.always : request.patterns;
      for (const pattern of patterns) {
        await this.persistAlwaysRule({
          permission: request.permission,
          pattern
        });
      }

      return {
        allowed: true,
        decision: "allow",
        source: "prompt",
        mode: "always",
        request,
        matched: evaluated.results,
        prompt_decision: {
          reply: "always",
          message: promptMessage
        }
      };
    }

    return {
      allowed: false,
      decision: "deny",
      source: "prompt",
      mode: "reject",
      request,
      matched: evaluated.results,
      reason: promptMessage || "rejected_by_user",
      prompt_decision: {
        reply: "reject",
        message: promptMessage
      }
    };
  }
}
