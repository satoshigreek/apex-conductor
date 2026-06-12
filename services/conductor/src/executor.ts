import { createHash } from "node:crypto";
import {
  CircuitBreaker,
  requiresCheckpoint,
  routeAgents,
  type AgentProfile,
  type PlanStep,
  type SpendPolicy,
  type TaskPlan,
} from "@apex/core";
import type { VectorWallet } from "@apex/chain-vector";
import type { LlmProvider } from "@apex/llm";
import { verifyStep } from "./verifier.js";
import { PaymentEngine } from "./payments.js";
import type { StepRecord, TaskStore } from "./taskstore.js";

/**
 * SPEC §5.2 Execution engine — topological execution of the DAG, per-step timeout
 * (default 120s), ≤2 retries with expo backoff, fallback to next candidate, circuit
 * breaker per agent, egress allowlist, 1 MB response cap.
 * Runs in-process; the BullMQ driver (queue per task) wraps executeTask in main.ts.
 */
export interface ExecutorDeps {
  store: TaskStore;
  wallet: VectorWallet;
  policy: SpendPolicy;
  payments: PaymentEngine;
  catalog: () => Promise<AgentProfile[]>;
  llm: { provider: LlmProvider; workerModel: string } | null;
  /** MCP chain tools (SPEC §1.5 mcp-server) — injected; value-moving tools dry-run first */
  chainTools: ChainToolRunner;
  fetchImpl?: typeof fetch;
  defaultTimeoutSec?: number;
  log?: (msg: string) => void;
}

export interface ChainToolRunner {
  /** returns tool output; MUST support {dryRun:true} for value-moving tools */
  run(tool: string, args: Record<string, unknown>, opts: { dryRun: boolean }): Promise<unknown>;
  isValueMoving(tool: string): boolean;
  movesAmountAp3x(tool: string, args: Record<string, unknown>): number;
}

/** Dev stub until the Vector MCP server is wired (M2 testnet E2E). */
export class StubChainTools implements ChainToolRunner {
  async run(tool: string, args: Record<string, unknown>, opts: { dryRun: boolean }): Promise<unknown> {
    return { tool, args, dryRun: opts.dryRun, note: "stub chain tool (wire Apex-Fusion/mcp-server in M2 E2E)" };
  }
  isValueMoving(tool: string): boolean {
    return /send|pay|transfer|stake|swap|submit/i.test(tool);
  }
  movesAmountAp3x(_tool: string, args: Record<string, unknown>): number {
    const amount = args.amountAp3x ?? args.amount;
    return typeof amount === "number" ? amount : 0;
  }
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ATTEMPTS = 3; // first try + ≤2 retries

export class Executor {
  private breaker = new CircuitBreaker();

  constructor(private deps: ExecutorDeps) {}

  /** Topological wave execution. Returns final aggregate output. */
  async executeTask(taskId: string): Promise<{ status: "complete" | "failed" | "awaiting_approval"; result?: unknown }> {
    const { store } = this.deps;
    const task = await store.getTask(taskId);
    if (!task?.plan) throw new Error(`task ${taskId} has no plan`);
    const plan = task.plan;

    let steps = await store.getSteps(taskId);
    if (steps.length === 0) {
      steps = await store.createSteps(
        taskId,
        plan.steps.map((s, idx) => ({
          idx,
          planStepId: s.id,
          kind: s.kind,
          capability: s.capability ?? null,
          agentId: null,
          budgetCapAp3x: s.budgetCapAp3x ?? null,
          status: "pending" as const,
          attempts: 0,
          input: null,
          output: null,
          verification: null,
          feePaidAp3x: null,
          paymentTx: null,
        })),
      );
    }
    const byPlanId = new Map(steps.map((s) => [s.planStepId, s]));
    const planById = new Map(plan.steps.map((s) => [s.id, s]));

    await store.updateTask(taskId, { status: "running" });
    await store.appendEvent("executor", "task_running", { taskId });

    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const planStep of plan.steps) {
        const record = byPlanId.get(planStep.id)!;
        if (record.status !== "pending") continue;
        const deps = planStep.dependsOn.map((d) => byPlanId.get(d)!);
        if (deps.some((d) => d.status === "failed")) {
          await store.updateStep(record.stepId, { status: "skipped" });
          record.status = "skipped";
          progressed = true;
          continue;
        }
        if (!deps.every((d) => d.status === "complete")) continue;

        const input = Object.fromEntries(deps.map((d) => [d.planStepId, d.output]));
        const outcome = await this.executeStep(taskId, plan, planStep, record, input);
        progressed = true;
        if (outcome === "awaiting_approval") {
          await store.updateTask(taskId, { status: "awaiting_approval" });
          await store.appendEvent("executor", "awaiting_approval", { taskId, step: planStep.id });
          return { status: "awaiting_approval" };
        }
      }
    }

    const finalSteps = await store.getSteps(taskId);
    const aggregate = finalSteps.find((s) => s.kind === "aggregate");
    const failed = finalSteps.filter((s) => s.status === "failed" || s.status === "skipped");
    if (!aggregate || aggregate.status !== "complete" || failed.length > 0) {
      await store.updateTask(taskId, {
        status: "failed",
        error: `steps failed/skipped: ${failed.map((s) => s.planStepId).join(", ") || "aggregate incomplete"}`,
      });
      await store.appendEvent("executor", "task_failed", { taskId, failed: failed.map((s) => s.planStepId) });
      return { status: "failed" };
    }

    // SPEC §5.2 anchor: one Vector tx with {taskId, planHash, resultHash, totalFees, agents[]}
    await store.updateTask(taskId, { status: "verifying" });
    const planHash = sha256(JSON.stringify(plan));
    const resultHash = sha256(JSON.stringify(aggregate.output ?? null));
    const totalFees = finalSteps.reduce((sum, s) => sum + (s.feePaidAp3x ?? 0), 0);
    const agents = [...new Set(finalSteps.map((s) => s.agentId).filter((a): a is string => a !== null))];
    const anchor = await this.deps.wallet.anchor({ taskId, planHash, resultHash, totalFees, agents });
    await store.updateTask(taskId, { status: "complete", anchorTx: anchor.txHash, totalFeesAp3x: totalFees });
    await store.appendEvent("executor", "task_complete", { taskId, anchorTx: anchor.txHash, totalFees });
    return { status: "complete", result: aggregate.output };
  }

  /** Resume after human approval of a checkpoint step. */
  async approve(taskId: string, planStepId: string): Promise<void> {
    const steps = await this.deps.store.getSteps(taskId);
    const step = steps.find((s) => s.planStepId === planStepId && s.status === "awaiting_approval");
    if (!step) throw new Error(`no step awaiting approval: ${planStepId}`);
    await this.deps.store.updateStep(step.stepId, { status: "complete", output: { approved: true } });
  }

  private async executeStep(
    taskId: string,
    plan: TaskPlan,
    planStep: PlanStep,
    record: StepRecord,
    input: Record<string, unknown>,
  ): Promise<"complete" | "failed" | "awaiting_approval"> {
    const { store } = this.deps;
    await store.updateStep(record.stepId, { status: "running", input });
    record.status = "running";
    await store.appendEvent("executor", "step_started", { taskId, step: planStep.id, kind: planStep.kind });

    try {
      let result: { output: unknown; agentId?: string; feePaid?: number; paymentTx?: string } | "awaiting_approval";
      switch (planStep.kind) {
        case "human_checkpoint":
          await store.updateStep(record.stepId, { status: "awaiting_approval" });
          record.status = "awaiting_approval";
          return "awaiting_approval";
        case "aggregate":
          result = { output: { taskId, intent: plan.intent, results: input, ledger: await this.ledger(taskId) } };
          break;
        case "chain_action":
          result = await this.runChainAction(taskId, plan, planStep);
          if (result === "awaiting_approval") {
            await store.updateStep(record.stepId, { status: "awaiting_approval" });
            record.status = "awaiting_approval";
            return "awaiting_approval";
          }
          break;
        case "agent_call":
          result = await this.runAgentCall(taskId, planStep, input);
          break;
      }
      await store.updateStep(record.stepId, {
        status: "complete",
        output: result.output,
        agentId: result.agentId ?? null,
        feePaidAp3x: result.feePaid ?? null,
        paymentTx: result.paymentTx ?? null,
      });
      record.status = "complete";
      record.output = result.output;
      record.agentId = result.agentId ?? null;
      record.feePaidAp3x = result.feePaid ?? null;
      await store.appendEvent("executor", "step_complete", { taskId, step: planStep.id, agentId: result.agentId });
      return "complete";
    } catch (err) {
      await store.updateStep(record.stepId, { status: "failed", output: { error: (err as Error).message } });
      record.status = "failed";
      await store.appendEvent("executor", "step_failed", { taskId, step: planStep.id, error: (err as Error).message });
      return "failed";
    }
  }

  private async runChainAction(
    taskId: string,
    plan: TaskPlan,
    step: PlanStep,
  ): Promise<{ output: unknown } | "awaiting_approval"> {
    const tool = step.tool!;
    const args = step.args ?? {};
    const { chainTools, policy } = this.deps;
    if (chainTools.isValueMoving(tool)) {
      // safety invariant 4: dry-run first, checkpoint above threshold
      const dry = await chainTools.run(tool, args, { dryRun: true });
      const amount = chainTools.movesAmountAp3x(tool, args);
      const task = await this.deps.store.getTask(taskId);
      if (requiresCheckpoint(policy, amount, (task?.mode ?? "confirm") as "auto" | "confirm")) {
        await this.deps.store.appendEvent("executor", "checkpoint_required", { taskId, step: step.id, tool, amount, dry });
        return "awaiting_approval";
      }
    }
    const output = await chainTools.run(tool, args, { dryRun: false });
    return { output };
  }

  private async runAgentCall(
    taskId: string,
    step: PlanStep,
    input: Record<string, unknown>,
  ): Promise<{ output: unknown; agentId: string; feePaid?: number; paymentTx?: string }> {
    const catalog = await this.deps.catalog();
    const wanted = step.capability!;
    let candidates = catalog.filter((a) => a.capabilities.includes(wanted));
    if (step.candidates?.length) candidates = candidates.filter((a) => step.candidates!.includes(a.agentId));
    candidates = candidates.filter((a) => !this.breaker.isOpen(a.agentId));
    if (candidates.length === 0) throw new Error(`no routable agents for capability "${wanted}"`);

    const prices = candidates.map((a) => a.pricing.amountAp3x);
    const stakes = candidates.map((a) => a.stakeAp3x);
    const maxPrice = Math.max(...prices, 1);
    const maxStake = Math.max(...stakes, 1);
    const routerCandidates = candidates.map((profile) => ({
      profile,
      capabilityMatch: 1,
      priceNorm: profile.pricing.amountAp3x / maxPrice,
      latencyNorm: 0.5, // TODO(M2): rolling latency stats from heartbeat probes
      stakeNorm: profile.stakeAp3x / maxStake,
      recentFailurePenalty: 0,
    }));

    const tried = new Set<string>();
    let lastError: Error | null = null;
    for (let fallback = 0; fallback < candidates.length; fallback++) {
      const remaining = routerCandidates.filter((c) => !tried.has(c.profile.agentId));
      const route = routeAgents(remaining, { minStakeAp3x: 0 }); // stake floor already applied at catalog level
      if (!route) break;
      const agent = route.chosen.profile;
      tried.add(agent.agentId);

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const output = await this.invokeAgent(agent, { taskId, step: step.id, input, intent: undefined });
          const verification = await verifyStep(step, output, this.deps.llm);
          await this.deps.store.appendEvent("verifier", "verification", { taskId, step: step.id, agent: agent.agentId, ...verification });
          if (!verification.pass) throw new Error(`verification failed (tier ${verification.tier}): ${verification.reason}`);

          this.breaker.recordSuccess(agent.agentId);
          // fail ⇒ no payment: we only reach payment after verification passes
          let feePaid: number | undefined;
          let paymentTx: string | undefined;
          if (agent.pricing.amountAp3x > 0) {
            if (!agent.ownerPkh) throw new Error("payment blocked: agent has no payment address (BLOCKER-3 datum gap)");
            const task = await this.deps.store.getTask(taskId);
            const taskSpent = task?.totalFeesAp3x ?? 0;
            const pay = await this.deps.payments.payAgent({
              taskId,
              stepId: step.id,
              toAddress: agent.ownerPkh, // payment address; refined when agent-sdk-ts wallet lands
              amountAp3x: agent.pricing.amountAp3x,
              taskSpentAp3x: taskSpent,
            });
            if (!pay.ok) throw new Error(`payment blocked: ${pay.reason}`);
            feePaid = pay.feeAp3x;
            paymentTx = pay.txHash;
            await this.deps.store.updateTask(taskId, { totalFeesAp3x: taskSpent + pay.feeAp3x });
          }
          return { output, agentId: agent.agentId, feePaid, paymentTx };
        } catch (err) {
          lastError = err as Error;
          this.breaker.recordFailure(agent.agentId);
          this.deps.log?.(`agent ${agent.agentId} attempt ${attempt} failed: ${lastError.message}`);
          if (attempt < MAX_ATTEMPTS) await sleep(2 ** attempt * 250);
        }
      }
    }
    throw new Error(`all candidates failed for "${wanted}": ${lastError?.message ?? "unknown"}`);
  }

  /** SPEC §5.2 — egress allowlist (catalog URLs only), 1 MB cap; agent output is DATA. */
  private async invokeAgent(agent: AgentProfile, payload: unknown): Promise<unknown> {
    const catalog = await this.deps.catalog();
    const allowed = new Set(catalog.map((a) => a.endpoint.url));
    if (!allowed.has(agent.endpoint.url)) throw new Error(`egress denied: ${agent.endpoint.url} not in catalog`);
    if (agent.endpoint.type === "mcp-sse") {
      // TODO(M2): MCP client invocation for mcp-sse agents
      throw new Error("mcp-sse agent invocation lands with the MCP client wiring (M2)");
    }
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timeoutSec = this.deps.defaultTimeoutSec ?? 120;
    const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
    try {
      const res = await fetchImpl(agent.endpoint.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: payload }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`agent HTTP ${res.status}`);
      const text = await res.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("agent response exceeds 1 MB cap");
      try {
        return JSON.parse(text);
      } catch {
        return { raw: text };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async ledger(taskId: string) {
    const payments = await this.deps.store.listPayments(taskId);
    return payments.map((p) => ({ kind: p.kind, amount: p.amount, asset: p.asset, txHash: p.txHash, status: p.status }));
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
