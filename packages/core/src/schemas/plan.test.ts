import { describe, expect, it } from "vitest";
import { PLAN_LIMITS, TaskPlanSchema, validatePlanConstraints, type TaskPlan } from "./plan.js";

function basePlan(overrides: Partial<TaskPlan> = {}): TaskPlan {
  return {
    planVersion: 1,
    taskId: "t1",
    intent: "test",
    budgetAp3x: 100,
    steps: [
      {
        id: "s1",
        kind: "agent_call",
        dependsOn: [],
        capability: "summarize",
        budgetCapAp3x: 10,
        verification: { tier: 0 },
      },
      { id: "agg", kind: "aggregate", dependsOn: ["s1"], verification: { tier: 0 } },
    ],
    ...overrides,
  };
}

describe("TaskPlanSchema", () => {
  it("accepts a minimal valid plan", () => {
    const plan = basePlan();
    expect(TaskPlanSchema.parse(plan)).toEqual(plan);
    expect(validatePlanConstraints(plan)).toEqual([]);
  });

  it("rejects wrong planVersion", () => {
    expect(TaskPlanSchema.safeParse({ ...basePlan(), planVersion: 2 }).success).toBe(false);
  });
});

describe("validatePlanConstraints", () => {
  it("rejects depth > 5", () => {
    const steps = [];
    for (let i = 0; i < PLAN_LIMITS.maxDepth + 1; i++) {
      steps.push({
        id: `s${i}`,
        kind: "agent_call" as const,
        dependsOn: i === 0 ? [] : [`s${i - 1}`],
        capability: "x",
        verification: { tier: 0 as const },
      });
    }
    steps.push({ id: "agg", kind: "aggregate" as const, dependsOn: [`s${PLAN_LIMITS.maxDepth}`], verification: { tier: 0 as const } });
    const violations = validatePlanConstraints(basePlan({ steps }));
    expect(violations.map((v) => v.code)).toContain("max_depth_exceeded");
  });

  it("rejects fan-out > 8", () => {
    const steps = [
      { id: "root", kind: "agent_call" as const, dependsOn: [], capability: "x", verification: { tier: 0 as const } },
    ];
    const leaves: string[] = [];
    for (let i = 0; i < PLAN_LIMITS.maxFanOut + 1; i++) {
      steps.push({ id: `f${i}`, kind: "agent_call" as const, dependsOn: ["root"], capability: "x", verification: { tier: 0 as const } });
      leaves.push(`f${i}`);
    }
    steps.push({ id: "agg", kind: "aggregate" as const, dependsOn: leaves, verification: { tier: 0 as const } });
    const violations = validatePlanConstraints(basePlan({ steps }));
    expect(violations.map((v) => v.code)).toContain("max_fanout_exceeded");
  });

  it("rejects worst-case cost > 0.8 × budget", () => {
    const plan = basePlan();
    plan.steps[0]!.budgetCapAp3x = 81;
    expect(validatePlanConstraints(plan).map((v) => v.code)).toContain("budget_exceeded");
  });

  it("doubles cost for critical steps (redundant execution)", () => {
    const plan = basePlan();
    plan.steps[0]!.budgetCapAp3x = 45;
    plan.steps[0]!.critical = true; // 90 > 80
    expect(validatePlanConstraints(plan).map((v) => v.code)).toContain("budget_exceeded");
  });

  it("requires exactly one terminal aggregate", () => {
    const none = basePlan();
    none.steps = none.steps.filter((s) => s.kind !== "aggregate");
    expect(validatePlanConstraints(none).map((v) => v.code)).toContain("aggregate_count");

    const notTerminal = basePlan({
      steps: [
        { id: "agg", kind: "aggregate", dependsOn: [], verification: { tier: 0 } },
        { id: "s1", kind: "agent_call", dependsOn: ["agg"], capability: "x", verification: { tier: 0 } },
      ],
    });
    expect(validatePlanConstraints(notTerminal).map((v) => v.code)).toContain("aggregate_not_terminal");
  });

  it("detects cycles", () => {
    const plan = basePlan({
      steps: [
        { id: "a", kind: "agent_call", dependsOn: ["b"], capability: "x", verification: { tier: 0 } },
        { id: "b", kind: "agent_call", dependsOn: ["a"], capability: "x", verification: { tier: 0 } },
        { id: "agg", kind: "aggregate", dependsOn: ["a"], verification: { tier: 0 } },
      ],
    });
    expect(validatePlanConstraints(plan).map((v) => v.code)).toContain("cycle");
  });

  it("rejects unknown dependencies and duplicate ids", () => {
    const plan = basePlan({
      steps: [
        { id: "s1", kind: "agent_call", dependsOn: ["ghost"], capability: "x", verification: { tier: 0 } },
        { id: "s1", kind: "aggregate", dependsOn: [], verification: { tier: 0 } },
      ],
    });
    const codes = validatePlanConstraints(plan).map((v) => v.code);
    expect(codes).toContain("unknown_dependency");
    expect(codes).toContain("duplicate_step_id");
  });

  it("fuzz: random DAGs within limits always validate; oversize always rejected", () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let trial = 0; trial < 200; trial++) {
      const n = 1 + Math.floor(rand() * 4);
      const steps = [];
      for (let i = 0; i < n; i++) {
        steps.push({
          id: `s${i}`,
          kind: "agent_call" as const,
          dependsOn: i > 0 && rand() < 0.5 ? [`s${i - 1}`] : [],
          capability: "x",
          budgetCapAp3x: Math.floor(rand() * 10),
          verification: { tier: 0 as const },
        });
      }
      steps.push({ id: "agg", kind: "aggregate" as const, dependsOn: steps.map((s) => s.id), verification: { tier: 0 as const } });
      const plan = basePlan({ budgetAp3x: 1000, steps });
      expect(validatePlanConstraints(plan)).toEqual([]);
    }
  });
});
