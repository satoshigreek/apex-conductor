/**
 * Local M2 E2E (SPEC §7 M2 shape, mock wallet):
 * live mainnet catalog → manifest fills BLOCKER-3 endpoint gap → routed agent_call
 * → tier-0 verification → payment after verification → anchor.
 * Prereqs: conductor on :4000 (ALLOW_UNVERIFIED_MANIFESTS=true), demo agents on :5001+.
 */
const API = "http://localhost:4000";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await wait(2000);
  }
  throw new Error(`timeout waiting for ${label}`);
}

// 1. wait for the live catalog (mainnet poll)
const agents = await until(async () => {
  const res = await fetch(`${API}/v1/agents?capability=code_review`);
  const list = await res.json();
  return list.length > 0 ? list : null;
}, "mainnet catalog");
const target = agents.find((a) => a.name === "DemoAlpha") ?? agents[0];
console.log(`live agent: ${target.name} (${target.agentId.slice(0, 40)}…) caps=[${target.capabilities}] routable=${target.routable}`);

// 2. POST a manifest pointing the live agent at the local NewsSummarizer endpoint
const manifestRes = await fetch(`${API}/v1/agents/${encodeURIComponent(target.agentId)}/manifest`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    endpoint: { type: "https", url: "http://localhost:5002" },
    pricing: { model: "per_call", amountAp3x: 2 },
    signature: "dev-unverified",
    publicKey: "dev-unverified",
  }),
});
console.log(`manifest: HTTP ${manifestRes.status} →`, await manifestRes.json());

// 3. confirm it became routable
const routable = await until(async () => {
  const res = await fetch(`${API}/v1/agents?capability=code_review`);
  const list = await res.json();
  const found = list.find((a) => a.agentId === target.agentId);
  return found?.routable ? found : null;
}, "routable agent");
console.log(`routable: ${routable.name} via ${routable.endpoint.url} @ ${routable.pricing.amountAp3x} AP3X (source=${routable.source.endpoint})`);

// 4. submit the intent (direct plan exercises executor+verifier+payments; capability routes to the manifested agent)
const intent = await fetch(`${API}/v1/intents`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    prompt: "Summarize: Apex Fusion launched the Vector agent registry. Agents stake AP3X for reputation. The MCP server exposes eighteen tools.",
    budgetAp3x: 20,
    mode: "auto",
    plan: {
      planVersion: 1,
      taskId: "x",
      intent: "summarize apex news",
      budgetAp3x: 20,
      steps: [
        {
          id: "summarize",
          kind: "agent_call",
          dependsOn: [],
          capability: "code_review",
          budgetCapAp3x: 5,
          verification: { tier: 0, outputSchema: { type: "object", required: ["kind", "headline"] } },
        },
        { id: "agg", kind: "aggregate", dependsOn: ["summarize"], verification: { tier: 0 } },
      ],
    },
  }),
});
const { taskId } = await intent.json();
console.log(`task: ${taskId}`);

// 5. await terminal state
const final = await until(async () => {
  const res = await fetch(`${API}/v1/tasks/${taskId}`);
  const view = await res.json();
  return ["complete", "failed"].includes(view.task.status) ? view : null;
}, "terminal task state");

console.log(`\nstatus: ${final.task.status}`);
console.log(`anchor: ${final.task.anchorTx}`);
console.log(`fees:   ${final.task.totalFeesAp3x} AP3X`);
console.log(`steps:  ${final.steps.map((s) => `${s.planStepId}=${s.status}${s.agentId ? ` (${s.agentId.slice(0, 20)}…, fee ${s.feePaidAp3x})` : ""}`).join(" · ")}`);
console.log(`ledger: ${JSON.stringify(final.payments.map((p) => ({ kind: p.kind, amount: p.amount, tx: p.txHash })))}`);
const agg = final.steps.find((s) => s.kind === "aggregate");
console.log(`result: ${JSON.stringify(agg.output.results.summarize).slice(0, 200)}`);
if (final.task.status !== "complete") process.exit(1);
console.log("\nE2E PASS");
