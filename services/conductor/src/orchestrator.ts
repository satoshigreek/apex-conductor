import type { AgentProfile, SpendPolicy, TaskMode } from "@apex/core";
import { TaskPlanSchema, validatePlanConstraints } from "@apex/core";
import type { VectorWallet } from "@apex/chain-vector";
import type { LlmProvider } from "@apex/llm";
import { planTask } from "./planner.js";
import { Executor, type ChainToolRunner } from "./executor.js";
import { PaymentEngine } from "./payments.js";
import type { TaskRecord, TaskStore } from "./taskstore.js";

/** Glue: intent → plan → (approval gate) → execute. The API and MCP surfaces both drive this. */
export interface OrchestratorDeps {
  store: TaskStore;
  wallet: VectorWallet;
  policy: SpendPolicy;
  catalog: () => Promise<AgentProfile[]>;
  planner: { provider: LlmProvider; model: string } | null;
  worker: { provider: LlmProvider; workerModel: string } | null;
  chainTools: ChainToolRunner;
  treasuryAddr: string | null;
  perTaskCapAp3x: number;
  /** queue indirection (SPEC: BullMQ per task in v1; inline for dev). Defaults to inline. */
  enqueue?: (taskId: string) => Promise<void>;
  log?: (msg: string) => void;
}

export class Orchestrator {
  readonly executor: Executor;
  private payments: PaymentEngine;

  constructor(private deps: OrchestratorDeps) {
    this.payments = new PaymentEngine({
      wallet: deps.wallet,
      store: deps.store,
      policy: deps.policy,
      treasuryAddr: deps.treasuryAddr,
      log: deps.log,
    });
    this.executor = new Executor({
      store: deps.store,
      wallet: deps.wallet,
      policy: deps.policy,
      payments: this.payments,
      catalog: deps.catalog,
      llm: deps.worker,
      chainTools: deps.chainTools,
      log: deps.log,
    });
  }

  async submitIntent(input: {
    prompt: string;
    budgetAp3x: number;
    mode: TaskMode;
    userId?: string;
    /** dev/test harness: a pre-built TaskPlan bypassing the LLM planner (still constraint-checked) */
    plan?: unknown;
  }): Promise<TaskRecord> {
    if (input.budgetAp3x > this.deps.perTaskCapAp3x) {
      throw Object.assign(new Error(`budget exceeds PER_TASK_CAP_AP3X (${this.deps.perTaskCapAp3x})`), { statusCode: 400 });
    }
    const task = await this.deps.store.createTask({
      intent: input.prompt,
      mode: input.mode,
      budgetAp3x: input.budgetAp3x,
      userId: input.userId,
    });
    await this.deps.store.appendEvent("api", "intent_received", { taskId: task.taskId, mode: input.mode });
    // plan + execute run async; callers watch GET /v1/tasks/:id and the SSE stream
    void this.planAndRun(task, input.plan).catch(async (err) => {
      await this.deps.store.updateTask(task.taskId, { status: "failed", error: (err as Error).message });
      await this.deps.store.appendEvent("orchestrator", "task_failed", { taskId: task.taskId, error: (err as Error).message });
    });
    return task;
  }

  private async planAndRun(task: TaskRecord, directPlan?: unknown): Promise<void> {
    const { store } = this.deps;
    if (directPlan !== undefined) {
      const parsed = TaskPlanSchema.safeParse(directPlan);
      if (!parsed.success) {
        await store.updateTask(task.taskId, { status: "failed", error: `invalid direct plan: ${parsed.error.message.slice(0, 300)}` });
        return;
      }
      const plan = { ...parsed.data, taskId: task.taskId, budgetAp3x: task.budgetAp3x };
      const violations = validatePlanConstraints(plan);
      if (violations.length) {
        await store.updateTask(task.taskId, { status: "failed", error: `plan violations: ${violations.map((v) => v.message).join("; ")}` });
        return;
      }
      await store.updateTask(task.taskId, { plan });
    } else {
      if (!this.deps.planner) {
        await store.updateTask(task.taskId, {
          status: "failed",
          error: "planning_unavailable: no LLM provider configured (set ANTHROPIC_API_KEY / VENICE_API_KEY / OPENAI_API_KEY)",
        });
        return;
      }
      const outcome = await planTask(
        this.deps.planner.provider,
        this.deps.planner.model,
        task.intent,
        task.budgetAp3x,
        {
          catalog: await this.deps.catalog(),
          walletAddress: await this.deps.wallet.address(),
          checkpointAp3x: this.deps.policy.checkpointAp3x,
        },
        task.taskId,
      );
      if (!outcome.ok) {
        await store.updateTask(task.taskId, { status: "failed", error: `planning_error: ${outcome.detail}` });
        await store.appendEvent("planner", "planning_error", { taskId: task.taskId, detail: outcome.detail });
        return;
      }
      await store.updateTask(task.taskId, { plan: outcome.plan });
      await store.appendEvent("planner", "plan_ready", { taskId: task.taskId, steps: outcome.plan.steps.length });
    }

    if (task.mode === "confirm") {
      await store.updateTask(task.taskId, { status: "awaiting_approval" });
      await store.appendEvent("orchestrator", "awaiting_plan_approval", { taskId: task.taskId });
      return; // resumed via approveTask
    }
    if (this.deps.enqueue) await this.deps.enqueue(task.taskId);
    else await this.executor.executeTask(task.taskId);
  }

  /** approve a confirm-mode plan, or an in-flight human_checkpoint step */
  async approveTask(taskId: string, planStepId?: string): Promise<void> {
    const task = await this.deps.store.getTask(taskId);
    if (!task) throw Object.assign(new Error("task not found"), { statusCode: 404 });
    if (task.status !== "awaiting_approval") throw Object.assign(new Error(`task is ${task.status}, not awaiting_approval`), { statusCode: 409 });
    if (planStepId) await this.executor.approve(taskId, planStepId);
    await this.deps.store.appendEvent("api", "approved", { taskId, planStepId: planStepId ?? null });
    await this.executor.executeTask(taskId);
  }

  async cancelTask(taskId: string): Promise<void> {
    const task = await this.deps.store.getTask(taskId);
    if (!task) throw Object.assign(new Error("task not found"), { statusCode: 404 });
    if (task.status === "complete") throw Object.assign(new Error("task already complete"), { statusCode: 409 });
    await this.deps.store.updateTask(taskId, { status: "failed", error: "cancelled by user" });
    await this.deps.store.appendEvent("api", "cancelled", { taskId });
  }
}
