import { randomUUID } from "node:crypto";
import {
  TaskPlanSchema,
  validatePlanConstraints,
  type AgentProfile,
  type TaskPlan,
} from "@apex/core";
import { CONDUCTOR_SYSTEM_PROMPT, parseJsonOutput, type ChatMessage, type LlmProvider } from "@apex/llm";

/** SPEC §5.2 Planner — §9 prompt verbatim + compacted catalog snapshot (top 50) + wallet context. */
export interface PlannerContext {
  catalog: AgentProfile[];
  walletAddress: string;
  checkpointAp3x: number;
}

export function compactCatalog(catalog: AgentProfile[], limit = 50): string {
  return catalog
    .slice(0, limit)
    .map(
      (a) =>
        `- id=${a.agentId} name=${a.name} caps=[${a.capabilities.join(",")}] price=${a.pricing.amountAp3x}AP3X/${a.pricing.model} stake=${a.stakeAp3x} rep=${a.reputation.score.toFixed(2)} endpoint=${a.endpoint.type}`,
    )
    .join("\n");
}

export function buildPlannerMessages(intent: string, budgetAp3x: number, taskId: string, ctx: PlannerContext): ChatMessage[] {
  const system = [
    CONDUCTOR_SYSTEM_PROMPT,
    "",
    `CHECKPOINT_AP3X=${ctx.checkpointAp3x}`,
    `Wallet: ${ctx.walletAddress}`,
    "",
    "AGENT CATALOG (the ONLY agents and endpoints that exist):",
    ctx.catalog.length ? compactCatalog(ctx.catalog) : "(catalog empty — plan chain_action/aggregate steps only)",
  ].join("\n");
  const user = JSON.stringify({ taskId, intent, budgetAp3x, planVersion: 1 });
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

export type PlanOutcome =
  | { ok: true; plan: TaskPlan }
  | { ok: false; error: "planning_error"; detail: string };

/** Parse with zod; on failure retry ONCE with validation errors appended; then fail (SPEC §5.2). */
export async function planTask(
  provider: LlmProvider,
  model: string,
  intent: string,
  budgetAp3x: number,
  ctx: PlannerContext,
  taskId: string = randomUUID(),
): Promise<PlanOutcome> {
  const messages = buildPlannerMessages(intent, budgetAp3x, taskId, ctx);
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const askMessages: ChatMessage[] =
      attempt === 0
        ? messages
        : [
            ...messages,
            { role: "assistant", content: "(previous attempt)" },
            {
              role: "user",
              content: `Your previous plan was invalid: ${lastError}. Return a corrected TaskPlan v1 JSON only.`,
            },
          ];
    const result = await provider.chat(askMessages, { model, jsonMode: true, temperature: 0 });
    const parsed = parseJsonOutput(TaskPlanSchema, result.text);
    if (!parsed.ok) {
      lastError = parsed.error;
      continue;
    }
    const plan = { ...parsed.value, taskId, budgetAp3x }; // ids/budget are server-authoritative
    const violations = validatePlanConstraints(plan);
    if (violations.length > 0) {
      lastError = violations.map((v) => v.message).join("; ");
      continue;
    }
    return { ok: true, plan };
  }
  return { ok: false, error: "planning_error", detail: lastError };
}
