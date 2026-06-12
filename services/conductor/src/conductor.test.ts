import { describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY, type AgentProfile, type TaskPlan } from "@apex/core";
import { MockVectorWallet } from "@apex/chain-vector";
import type { ChatMessage, ChatOptions, ChatResult, LlmProvider } from "@apex/llm";
import { MemoryTaskStore } from "./taskstore.js";
import { planTask } from "./planner.js";
import { Orchestrator } from "./orchestrator.js";
import { StubChainTools } from "./executor.js";
import { verifyTier0 } from "./verifier.js";

function agent(id: string, capability: string, price = 5, url = `https://agents.example/${id}`): AgentProfile {
  return {
    agentId: id,
    name: id,
    capabilities: [capability],
    endpoint: { type: "https", url },
    pricing: { model: "per_call", amountAp3x: price },
    stakeAp3x: 1000,
    ownerPkh: `addr_${id}`,
    registeredTx: "tx",
    reputation: { score: 0.8, tasks: 5, disputes: 0 },
  };
}

function fakeProvider(responses: string[]): LlmProvider {
  let i = 0;
  return {
    name: "fake",
    async chat(_messages: ChatMessage[], _opts: ChatOptions): Promise<ChatResult> {
      return { text: responses[Math.min(i++, responses.length - 1)]! };
    },
  };
}

function validPlan(taskId: string): TaskPlan {
  return {
    planVersion: 1,
    taskId,
    intent: "summarize the news",
    budgetAp3x: 50,
    steps: [
      {
        id: "fetch",
        kind: "agent_call",
        dependsOn: [],
        capability: "news",
        budgetCapAp3x: 5,
        verification: { tier: 0, outputSchema: { type: "object", required: ["headline"] } },
      },
      { id: "agg", kind: "aggregate", dependsOn: ["fetch"], verification: { tier: 0 } },
    ],
  };
}

describe("planTask", () => {
  it("accepts a valid first response", async () => {
    const provider = fakeProvider([JSON.stringify(validPlan("t1"))]);
    const outcome = await planTask(provider, "model", "summarize the news", 50, {
      catalog: [agent("a1", "news")],
      walletAddress: "addr",
      checkpointAp3x: 50,
    });
    expect(outcome.ok).toBe(true);
  });

  it("retries once with validation errors, then fails with planning_error", async () => {
    const bad = JSON.stringify({ planVersion: 1 }); // schema-invalid
    const provider = fakeProvider([bad, bad]);
    const outcome = await planTask(provider, "model", "x", 50, { catalog: [], walletAddress: "a", checkpointAp3x: 50 });
    expect(outcome).toMatchObject({ ok: false, error: "planning_error" });
  });

  it("rejects constraint-violating plans even when schema-valid", async () => {
    const over = validPlan("t");
    over.steps[0]!.budgetCapAp3x = 49; // > 0.8 × 50
    const provider = fakeProvider([JSON.stringify(over), JSON.stringify(over)]);
    const outcome = await planTask(provider, "model", "x", 50, { catalog: [], walletAddress: "a", checkpointAp3x: 50 });
    expect(outcome.ok).toBe(false);
  });
});

describe("verifyTier0", () => {
  it("checks outputSchema and reports errors", () => {
    const step = validPlan("t").steps[0]!;
    expect(verifyTier0(step, { headline: "hi" }).pass).toBe(true);
    const fail = verifyTier0(step, { nope: 1 });
    expect(fail.pass).toBe(false);
    expect(fail.reason).toMatch(/headline/);
  });
});

function buildOrchestrator(catalog: AgentProfile[], fetchImpl: typeof fetch) {
  const store = new MemoryTaskStore();
  const wallet = new MockVectorWallet();
  const orchestrator = new Orchestrator({
    store,
    wallet,
    policy: DEFAULT_POLICY,
    catalog: async () => catalog,
    planner: null,
    worker: null,
    chainTools: new StubChainTools(),
    treasuryAddr: "addr_treasury",
    perTaskCapAp3x: DEFAULT_POLICY.perTaskCapAp3x,
    log: () => undefined,
  });
  // executor fetch goes through the egress allowlist; inject the fake network
  (orchestrator.executor as unknown as { deps: { fetchImpl: typeof fetch } }).deps.fetchImpl = fetchImpl;
  return { store, wallet, orchestrator };
}

async function waitForTerminal(store: MemoryTaskStore, taskId: string) {
  for (let i = 0; i < 100; i++) {
    const task = await store.getTask(taskId);
    if (task && ["complete", "failed", "awaiting_approval"].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("task never reached terminal state");
}

describe("Orchestrator E2E (direct plan, mock wallet, fake agents)", () => {
  it("executes plan → verifies → pays after verification → anchors (SPEC M2 E2E shape)", async () => {
    const catalog = [agent("news1", "news")];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toBe("https://agents.example/news1");
      return new Response(JSON.stringify({ headline: "AP3X up" }), { status: 200 });
    }) as unknown as typeof fetch;
    const { store, wallet, orchestrator } = buildOrchestrator(catalog, fetchImpl);

    const task = await orchestrator.submitIntent({
      prompt: "summarize the news",
      budgetAp3x: 50,
      mode: "auto",
      plan: validPlan("ignored"),
    });
    const final = await waitForTerminal(store, task.taskId);

    expect(final.status).toBe("complete");
    expect(final.anchorTx).toMatch(/^mock_anchor_/);
    expect(final.totalFeesAp3x).toBe(5);
    // agent fee + 2.5% protocol fee, both AFTER verification
    expect(wallet.payments.map((p) => p.toAddress)).toEqual(["addr_news1", "addr_treasury"]);
    expect(wallet.payments[1]!.amountAp3x).toBeCloseTo(0.125);
    const payments = await store.listPayments(task.taskId);
    expect(payments.map((p) => p.kind).sort()).toEqual(["protocol_fee", "release"]);
    expect(wallet.anchors[0]).toMatchObject({ taskId: task.taskId, totalFees: 5, agents: ["news1"] });
  });

  it("no payment when verification fails; falls back and ultimately fails the task", async () => {
    const catalog = [agent("bad", "news")];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ wrong: true }), { status: 200 })) as unknown as typeof fetch;
    const { store, wallet, orchestrator } = buildOrchestrator(catalog, fetchImpl);

    const task = await orchestrator.submitIntent({ prompt: "x", budgetAp3x: 50, mode: "auto", plan: validPlan("ignored") });
    const final = await waitForTerminal(store, task.taskId);
    expect(final.status).toBe("failed");
    expect(wallet.payments).toHaveLength(0); // fail ⇒ no payment
  });

  it("egress allowlist blocks endpoints not in the catalog", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const { orchestrator } = buildOrchestrator([agent("news1", "news")], fetchImpl);
    const rogue = agent("rogue", "news", 5, "https://evil.example/agent");
    const invoke = (
      orchestrator.executor as unknown as { invokeAgent: (a: AgentProfile, p: unknown) => Promise<unknown> }
    ).invokeAgent.bind(orchestrator.executor);
    await expect(invoke(rogue, {})).rejects.toThrow(/egress denied/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("confirm mode pauses for approval, then approve runs the task", async () => {
    const catalog = [agent("news1", "news")];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ headline: "ok" }), { status: 200 })) as unknown as typeof fetch;
    const { store, orchestrator } = buildOrchestrator(catalog, fetchImpl);

    const task = await orchestrator.submitIntent({ prompt: "x", budgetAp3x: 50, mode: "confirm", plan: validPlan("ignored") });
    const paused = await waitForTerminal(store, task.taskId);
    expect(paused.status).toBe("awaiting_approval");

    await orchestrator.approveTask(task.taskId);
    const final = await store.getTask(task.taskId);
    expect(final?.status).toBe("complete");
  });

  it("rejects budgets above PER_TASK_CAP_AP3X in code", async () => {
    const { orchestrator } = buildOrchestrator([], vi.fn() as unknown as typeof fetch);
    await expect(
      orchestrator.submitIntent({ prompt: "x", budgetAp3x: DEFAULT_POLICY.perTaskCapAp3x + 1, mode: "auto" }),
    ).rejects.toThrow(/PER_TASK_CAP_AP3X/);
  });
});
