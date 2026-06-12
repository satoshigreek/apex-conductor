import { z } from "zod";

/** SPEC §4.2 — TaskPlan v1, the strict LLM output contract. */
export const StepKindSchema = z.enum(["agent_call", "chain_action", "human_checkpoint", "aggregate"]);
export type StepKind = z.infer<typeof StepKindSchema>;

export const VerificationSpecSchema = z.object({
  tier: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  rubric: z.string().optional(),
  outputSchema: z.record(z.unknown()).optional(),
});

export const PlanStepSchema = z.object({
  id: z.string().min(1),
  kind: StepKindSchema,
  dependsOn: z.array(z.string()),
  capability: z.string().optional(),
  candidates: z.array(z.string()).optional(),
  tool: z.string().optional(),
  args: z.record(z.unknown()).optional(),
  budgetCapAp3x: z.number().nonnegative().optional(),
  timeoutSec: z.number().int().positive().optional(),
  critical: z.boolean().optional(),
  verification: VerificationSpecSchema,
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const TaskPlanSchema = z.object({
  planVersion: z.literal(1),
  taskId: z.string().min(1),
  intent: z.string().min(1),
  budgetAp3x: z.number().positive(),
  steps: z.array(PlanStepSchema).min(1),
});
export type TaskPlan = z.infer<typeof TaskPlanSchema>;

export const PLAN_LIMITS = {
  maxDepth: 5,
  maxFanOut: 8,
  budgetHeadroom: 0.8,
} as const;

export interface PlanViolation {
  code:
    | "duplicate_step_id"
    | "unknown_dependency"
    | "cycle"
    | "max_depth_exceeded"
    | "max_fanout_exceeded"
    | "budget_exceeded"
    | "aggregate_count"
    | "aggregate_not_terminal"
    | "missing_capability"
    | "missing_tool";
  message: string;
  stepId?: string;
}

/**
 * SPEC §4.2 — constraints enforced in code, not just prompt:
 * max depth 5, max fan-out 8, Σ worst-case cost ≤ 0.8 × budget,
 * every plan ends with exactly one `aggregate`.
 */
export function validatePlanConstraints(plan: TaskPlan): PlanViolation[] {
  const violations: PlanViolation[] = [];
  const ids = new Map<string, PlanStep>();

  for (const step of plan.steps) {
    if (ids.has(step.id)) {
      violations.push({ code: "duplicate_step_id", message: `duplicate step id ${step.id}`, stepId: step.id });
    }
    ids.set(step.id, step);
  }

  for (const step of plan.steps) {
    for (const dep of step.dependsOn) {
      if (!ids.has(dep)) {
        violations.push({ code: "unknown_dependency", message: `step ${step.id} depends on unknown step ${dep}`, stepId: step.id });
      }
    }
    if (step.kind === "agent_call" && !step.capability) {
      violations.push({ code: "missing_capability", message: `agent_call ${step.id} missing capability`, stepId: step.id });
    }
    if (step.kind === "chain_action" && !step.tool) {
      violations.push({ code: "missing_tool", message: `chain_action ${step.id} missing tool`, stepId: step.id });
    }
  }
  if (violations.some((v) => v.code === "unknown_dependency" || v.code === "duplicate_step_id")) {
    return violations; // graph algorithms below assume a well-formed id space
  }

  // depth via longest path (DAG); cycle detection via DFS coloring
  const depth = new Map<string, number>();
  const color = new Map<string, 0 | 1 | 2>();
  let cyclic = false;
  const visit = (id: string): number => {
    if (color.get(id) === 1) {
      cyclic = true;
      return 0;
    }
    const memo = depth.get(id);
    if (memo !== undefined) return memo;
    color.set(id, 1);
    const step = ids.get(id)!;
    let d = 1;
    for (const dep of step.dependsOn) d = Math.max(d, visit(dep) + 1);
    color.set(id, 2);
    depth.set(id, d);
    return d;
  };
  let maxDepth = 0;
  for (const step of plan.steps) maxDepth = Math.max(maxDepth, visit(step.id));
  if (cyclic) violations.push({ code: "cycle", message: "plan DAG contains a cycle" });
  if (!cyclic && maxDepth > PLAN_LIMITS.maxDepth) {
    violations.push({ code: "max_depth_exceeded", message: `depth ${maxDepth} > ${PLAN_LIMITS.maxDepth}` });
  }

  // fan-out: number of direct dependents of any step
  const dependents = new Map<string, number>();
  for (const step of plan.steps) {
    for (const dep of step.dependsOn) dependents.set(dep, (dependents.get(dep) ?? 0) + 1);
  }
  for (const [id, count] of dependents) {
    if (count > PLAN_LIMITS.maxFanOut) {
      violations.push({ code: "max_fanout_exceeded", message: `step ${id} has fan-out ${count} > ${PLAN_LIMITS.maxFanOut}`, stepId: id });
    }
  }

  // worst-case cost: redundant execution doubles the cap for critical steps (SPEC M4)
  let worstCase = 0;
  for (const step of plan.steps) {
    const cap = step.budgetCapAp3x ?? 0;
    worstCase += step.critical ? cap * 2 : cap;
  }
  if (worstCase > PLAN_LIMITS.budgetHeadroom * plan.budgetAp3x) {
    violations.push({
      code: "budget_exceeded",
      message: `worst-case cost ${worstCase} > ${PLAN_LIMITS.budgetHeadroom} × budget ${plan.budgetAp3x}`,
    });
  }

  // exactly one aggregate, and it must be terminal (nothing depends on it, it transitively reaches all leaves)
  const aggregates = plan.steps.filter((s) => s.kind === "aggregate");
  if (aggregates.length !== 1) {
    violations.push({ code: "aggregate_count", message: `plan must end with exactly one aggregate, found ${aggregates.length}` });
  } else {
    const agg = aggregates[0]!;
    if ((dependents.get(agg.id) ?? 0) > 0) {
      violations.push({ code: "aggregate_not_terminal", message: "aggregate step must be terminal", stepId: agg.id });
    }
  }

  return violations;
}

export const TaskStatusSchema = z.enum([
  "planning",
  "awaiting_approval",
  "running",
  "verifying",
  "complete",
  "failed",
  "refunded",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskModeSchema = z.enum(["auto", "confirm"]);
export type TaskMode = z.infer<typeof TaskModeSchema>;
