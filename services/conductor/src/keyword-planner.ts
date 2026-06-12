import { randomUUID } from "node:crypto";
import type { AgentProfile, TaskPlan } from "@apex/core";

/**
 * Degraded-mode planner — used ONLY when no LLM provider is configured.
 * Token-overlap capability match → single agent_call + aggregate. Clearly labeled in
 * events as `keyword-fallback`; the §9 LLM planner takes over the moment an API key
 * (ANTHROPIC/VENICE/OPENAI) is set.
 */
const SYNONYMS: Record<string, string[]> = {
  news: ["research", "summarize", "data_analysis", "analytics"],
  price: ["quote", "analytics", "data_analysis"],
  stake: ["staking", "stake-quote"],
  staking: ["stake-quote"],
  audit: ["security_audit", "code_review"],
  review: ["code_review", "critique"],
  analyze: ["data_analysis", "analytics", "research"],
  summary: ["summarize", "research"],
  governance: ["governance", "proposal-writing"],
};

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((t) => t.length > 2);
}

export function keywordPlan(intent: string, budgetAp3x: number, catalog: AgentProfile[], taskId: string = randomUUID()): TaskPlan | null {
  if (catalog.length === 0) return null;
  const wanted = new Set<string>();
  for (const token of tokens(intent)) {
    wanted.add(token);
    for (const syn of SYNONYMS[token] ?? []) wanted.add(syn);
  }

  let best: { agent: AgentProfile; capability: string; score: number } | null = null;
  for (const agent of catalog) {
    for (const capability of agent.capabilities) {
      const capTokens = tokens(capability.replace(/[_-]/g, " "));
      let score = 0;
      if (wanted.has(capability.toLowerCase())) score += 3;
      for (const ct of capTokens) if (wanted.has(ct)) score += 2;
      score += agent.reputation.score; // tie-break by reputation
      if (!best || score > best.score) best = { agent, capability, score };
    }
  }
  if (!best) return null;

  const cap = Math.min(best.agent.pricing.amountAp3x * 2 + 1, 0.8 * budgetAp3x);
  return {
    planVersion: 1,
    taskId,
    intent,
    budgetAp3x,
    steps: [
      {
        id: "call",
        kind: "agent_call",
        dependsOn: [],
        capability: best.capability,
        candidates: undefined,
        budgetCapAp3x: cap,
        timeoutSec: 120,
        verification: { tier: 0 },
      },
      { id: "agg", kind: "aggregate", dependsOn: ["call"], verification: { tier: 0 } },
    ],
  };
}
