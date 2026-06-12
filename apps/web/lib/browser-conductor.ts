import type { TaskView } from "./api";
import { VIRTUAL_AGENTS, type VirtualAgent } from "./virtual-agents";

/**
 * Browser conductor — demo-mode orchestration that runs entirely in the page:
 * keyword planning over the virtual-agent roster, sequential DAG execution against
 * live public APIs, a simulated AP3X ledger (2.5% protocol fee), mock anchor.
 * Tasks persist to localStorage so /tasks works. A connected node replaces all of this.
 */
const PROTOCOL_FEE_BPS = 250;
const STORE_KEY = "apex-browser-tasks";

function loadTasks(): Record<string, TaskView> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function saveTask(view: TaskView): void {
  const all = loadTasks();
  all[view.task.taskId] = view;
  const ids = Object.keys(all);
  if (ids.length > 30) delete all[ids[0]!];
  localStorage.setItem(STORE_KEY, JSON.stringify(all));
}

export function getBrowserTask(taskId: string): TaskView | null {
  return loadTasks()[taskId] ?? null;
}

/** split a compound intent into up to 3 sub-intents and match each to the best virtual agent */
function plan(intent: string): Array<{ subIntent: string; agent: VirtualAgent }> {
  const parts = intent
    .split(/\s+(?:and then|and also|and|then|;|\+)\s+/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 2)
    .slice(0, 3);
  const subIntents = parts.length > 0 ? parts : [intent];

  const picks: Array<{ subIntent: string; agent: VirtualAgent }> = [];
  for (const sub of subIntents) {
    const words = new Set(sub.toLowerCase().split(/[^a-z0-9_-]+/));
    let best: { agent: VirtualAgent; score: number } | null = null;
    for (const agent of VIRTUAL_AGENTS) {
      let score = 0;
      for (const cap of agent.capabilities) {
        if (words.has(cap)) score += 3;
        for (const t of cap.split(/[_-]/)) if (words.has(t)) score += 2;
      }
      for (const syn of agentSynonyms(agent)) if (words.has(syn)) score += 2;
      if (!best || score > best.score) best = { agent, score };
    }
    if (best && best.score > 0) picks.push({ subIntent: sub, agent: best.agent });
  }
  if (picks.length === 0) picks.push({ subIntent: intent, agent: VIRTUAL_AGENTS[0]! }); // default: news/research
  // dedupe same agent twice with identical sub-intent
  return picks.filter((p, i) => picks.findIndex((q) => q.agent.agentId === p.agent.agentId && q.subIntent === p.subIntent) === i);
}

function agentSynonyms(agent: VirtualAgent): string[] {
  switch (agent.agentId) {
    case "virtual:news": return ["news", "headlines", "happening", "iran", "going", "research", "report"];
    case "virtual:price": return ["price", "worth", "cost", "usd", "btc", "eth", "ada", "ap3x", "apex"];
    case "virtual:market": return ["market", "pool", "liquidity", "volume", "fdv", "aerodrome", "dex", "bap3x"];
    case "virtual:chain": return ["chain", "block", "epoch", "supply", "vector", "network", "tip"];
    case "virtual:staking": return ["stake", "staking", "yield", "apy", "earn"];
    case "virtual:registry": return ["registry", "agents", "registered"];
    default: return [];
  }
}

export async function conductInBrowser(intent: string, budgetAp3x: number): Promise<{ taskId: string }> {
  const taskId = crypto.randomUUID();
  const picks = plan(intent);
  const now = new Date().toISOString();

  const view: TaskView = {
    task: {
      taskId, intent, mode: "auto", budgetAp3x, status: "running",
      plan: {
        steps: [
          ...picks.map((p, i) => ({
            id: `call${i + 1}`, kind: "agent_call", dependsOn: [],
            capability: p.agent.capabilities[0], budgetCapAp3x: p.agent.priceAp3x * 2,
          })),
          { id: "agg", kind: "aggregate", dependsOn: picks.map((_, i) => `call${i + 1}`) },
        ],
      },
      totalFeesAp3x: 0, anchorTx: null, error: null, createdAt: now,
    },
    steps: [
      ...picks.map((p, i) => ({
        stepId: `${taskId}-c${i + 1}`, planStepId: `call${i + 1}`, kind: "agent_call",
        status: "running", agentId: p.agent.agentId, output: null as unknown, feePaidAp3x: null, paymentTx: null,
      })),
      { stepId: `${taskId}-agg`, planStepId: "agg", kind: "aggregate", status: "pending", agentId: null, output: null as unknown, feePaidAp3x: null, paymentTx: null },
    ],
    payments: [],
  };
  saveTask(view);

  // async execution; UI polls getBrowserTask
  void (async () => {
    const results: Record<string, unknown> = {};
    let fees = 0;
    for (const [i, pick] of picks.entries()) {
      const step = view.steps[i]!;
      try {
        const output = await pick.agent.run(pick.subIntent);
        step.output = output;
        step.status = "complete";
        if (fees + pick.agent.priceAp3x <= budgetAp3x) {
          step.feePaidAp3x = pick.agent.priceAp3x;
          fees += pick.agent.priceAp3x;
          view.payments.push({ kind: "release", amount: pick.agent.priceAp3x, asset: "AP3X (simulated)", txHash: null, status: "confirmed" });
        }
        results[step.planStepId] = output;
      } catch (err) {
        step.status = "failed";
        step.output = { error: (err as Error).message };
      }
      saveTask(view);
    }
    const protocolFee = (fees * PROTOCOL_FEE_BPS) / 10_000;
    if (protocolFee > 0) view.payments.push({ kind: "protocol_fee", amount: protocolFee, asset: "AP3X (simulated)", txHash: null, status: "confirmed" });

    const agg = view.steps[view.steps.length - 1]!;
    const anyOk = view.steps.some((s) => s.kind === "agent_call" && s.status === "complete");
    agg.status = anyOk ? "complete" : "failed";
    agg.output = { taskId, intent, results, ledger: view.payments };
    view.task.totalFeesAp3x = fees;
    view.task.status = anyOk ? "complete" : "failed";
    view.task.error = anyOk ? null : "all virtual agents failed (public APIs unreachable?)";
    view.task.anchorTx = anyOk ? `browser_demo_${taskId.slice(0, 8)}` : null;
    saveTask(view);
  })();

  return { taskId };
}
