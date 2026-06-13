/** Client helpers for the conductor + refuel APIs (proxied via next.config rewrites). */

export interface TaskView {
  task: {
    taskId: string;
    intent: string;
    mode: string;
    budgetAp3x: number;
    status: string;
    plan: { steps: PlanStepView[] } | null;
    totalFeesAp3x: number;
    anchorTx: string | null;
    error: string | null;
    createdAt: string;
  };
  steps: StepView[];
  payments: PaymentView[];
}

export interface PlanStepView {
  id: string;
  kind: string;
  dependsOn: string[];
  capability?: string;
  tool?: string;
  budgetCapAp3x?: number;
}

export interface StepView {
  stepId: string;
  planStepId: string;
  kind: string;
  status: string;
  agentId: string | null;
  output: unknown;
  feePaidAp3x: number | null;
  paymentTx: string | null;
}

export interface PaymentView {
  kind: string;
  amount: number;
  asset: string;
  txHash: string | null;
  status: string;
}

export interface AgentView {
  agentId: string;
  name: string;
  capabilities: string[];
  endpoint: { type: string; url: string } | null;
  pricing: { model: string; amountAp3x: number } | null;
  stakeAp3x: number;
  reputation: { score: number; tasks: number; disputes: number };
  status: string;
  routable: boolean;
  source: { endpoint: string; pricing: string } | null;
}

import { fetchCatalogStatic, getNodeUrl, isStaticMode, quoteRefuelStatic, STATIC_MODE_HINT } from "./static-mode";

const REFUEL = "/api/refuel";

/** conductor base: connected node (static mode with a node URL) or the local dev proxy */
function conductorBase(): string {
  if (isStaticMode()) {
    const node = getNodeUrl();
    if (node) return node;
    throw new Error(STATIC_MODE_HINT);
  }
  return "/api/conductor";
}

const browserMode = () => isStaticMode() && !getNodeUrl();

export async function submitIntent(prompt: string, budgetAp3x: number, mode: "auto" | "confirm"): Promise<{ taskId: string }> {
  if (browserMode()) {
    const { conductInBrowser } = await import("./browser-conductor");
    return conductInBrowser(prompt, budgetAp3x);
  }
  const res = await fetch(`${conductorBase()}/v1/intents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, budgetAp3x, mode }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? "request failed");
  return res.json();
}

export async function getTask(taskId: string): Promise<TaskView> {
  if (browserMode()) {
    const { getBrowserTask } = await import("./browser-conductor");
    const view = getBrowserTask(taskId);
    if (!view) throw new Error("task not found in this browser");
    return view;
  }
  try {
    const res = await fetch(`${conductorBase()}/v1/tasks/${taskId}`, isStaticMode() ? { signal: AbortSignal.timeout(8000) } : undefined);
    if (!res.ok) throw new Error(`task fetch failed: ${res.status}`);
    return res.json();
  } catch (err) {
    // node unreachable: browser-conducted tasks are still viewable from local storage
    if (isStaticMode()) {
      const { getBrowserTask } = await import("./browser-conductor");
      const view = getBrowserTask(taskId);
      if (view) return view;
    }
    throw err;
  }
}

export async function approveTask(taskId: string, stepId?: string): Promise<void> {
  const res = await fetch(`${conductorBase()}/v1/tasks/${taskId}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(stepId ? { stepId } : {}),
  });
  if (!res.ok) throw new Error(`approve failed: ${res.status}`);
}

export async function listAgents(capability?: string): Promise<AgentView[]> {
  if (isStaticMode()) {
    const node = getNodeUrl();
    if (node) {
      // a dead saved node must not break the marketplace — fall back to the live on-chain catalog
      try {
        const res = await fetch(`${node}/v1/agents${capability ? `?capability=${encodeURIComponent(capability)}` : ""}`, {
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) return res.json();
      } catch {
        /* fall through to static catalog */
      }
    }
    return fetchCatalogStatic(capability);
  }
  const res = await fetch(`/api/conductor/v1/agents${capability ? `?capability=${encodeURIComponent(capability)}` : ""}`);
  if (!res.ok) throw new Error(`agents fetch failed: ${res.status}`);
  return res.json();
}

export interface RefuelQuoteResult {
  live: boolean;
  quote: { usdcIn: number; bap3xOut: number; minBap3xOut: number; slippageBps: number };
  swapTx: string | null;
  bridge: { id: string; state: string; deepLink?: string } | null;
  creditedAp3x: number | null;
  gasBalanceAp3x: number | null;
}

export async function requestRefuel(usdcAmount: number, vectorAddress: string, maxSlippageBps = 100): Promise<RefuelQuoteResult> {
  if (isStaticMode()) return quoteRefuelStatic(usdcAmount, maxSlippageBps);
  const res = await fetch(`${REFUEL}/v1/refuel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ usdcAmount, vectorAddress, mode: "swap_and_bridge", maxSlippageBps }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? "refuel failed");
  return res.json();
}

export async function gasBalance(vectorAddress: string): Promise<number> {
  if (isStaticMode()) return 0; // gas ledger lives on the refuel service
  const res = await fetch(`${REFUEL}/v1/gas/${encodeURIComponent(vectorAddress)}`);
  if (!res.ok) return 0;
  return (await res.json()).balanceAp3x ?? 0;
}

export const EXPLORER_TX = (hash: string) => `https://explorer.vector.mainnet.apexfusion.org/tx/${hash}`;
export const COINGECKO_AP3X = "https://api.coingecko.com/api/v3/simple/price?ids=apex-fusion&vs_currencies=usd";
