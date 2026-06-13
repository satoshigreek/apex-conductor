"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { approveTask, getTask, submitIntent, COINGECKO_AP3X, EXPLORER_TX, type TaskView } from "@/lib/api";
import { getNodeUrl, isStaticMode, setNodeUrl } from "@/lib/static-mode";

/** SPEC §5.5 `/` — Conductor chat: Plan Card (DAG checklist), approval buttons, live budget meter. */
export default function ConductorPage() {
  const [prompt, setPrompt] = useState("");
  const [budget, setBudget] = useState(50);
  const [mode, setMode] = useState<"auto" | "confirm">("confirm");
  const [view, setView] = useState<TaskView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ap3xUsd, setAp3xUsd] = useState<number | null>(null);
  const [staticMode, setStaticMode] = useState(false);
  const [nodeUrl, setNodeUrlState] = useState("");
  const [nodeSaved, setNodeSaved] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setStaticMode(isStaticMode());
    const saved = getNodeUrl();
    setNodeSaved(saved);
    if (saved) setNodeUrlState(saved);
    // self-heal: a saved node that died (e.g. expired tunnel) must never brick the page
    if (saved && isStaticMode()) {
      void fetch(`${saved}/health`, { signal: AbortSignal.timeout(5000) })
        .then((res) => {
          if (!res.ok) throw new Error("unhealthy");
        })
        .catch(() => {
          setNodeUrl(null);
          setNodeSaved(null);
          setNodeUrlState("");
          setError(`saved node ${saved} was unreachable — switched to browser demo mode automatically (tunnels expire when their host stops)`);
        });
    }
  }, []);

  useEffect(() => {
    fetch(COINGECKO_AP3X)
      .then((r) => r.json())
      .then((b) => setAp3xUsd(b["apex-fusion"]?.usd ?? null))
      .catch(() => setAp3xUsd(null));
  }, []);

  const watch = useCallback((taskId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const next = await getTask(taskId);
        setView(next);
        if (["complete", "failed"].includes(next.task.status) && pollRef.current) clearInterval(pollRef.current);
      } catch {
        /* keep polling */
      }
    }, 1000);
  }, []);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { taskId } = await submitIntent(prompt, budget, mode);
      const ids: string[] = JSON.parse(localStorage.getItem("apex-task-ids") ?? "[]");
      localStorage.setItem("apex-task-ids", JSON.stringify([taskId, ...ids].slice(0, 50)));
      setView(await getTask(taskId));
      watch(taskId);
    } catch (err) {
      const message = (err as Error).message;
      setError(
        /failed to fetch|networkerror|load failed/i.test(message) && nodeSaved
          ? `connected node is unreachable (${nodeSaved}) — tunnels expire when the host machine stops. Disconnect below to use browser demo mode, or point at a live node.`
          : message,
      );
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!view) return;
    const checkpoint = view.steps.find((s) => s.status === "awaiting_approval");
    await approveTask(view.task.taskId, checkpoint?.planStepId);
    watch(view.task.taskId);
  };

  const spent = view?.task.totalFeesAp3x ?? 0;
  const budgetPct = view ? Math.min(100, (spent / view.task.budgetAp3x) * 100) : 0;

  return (
    <div className="grid gap-8 lg:grid-cols-[1.5fr_1fr]">
      <section>
        <p className="eyebrow mb-2">Natural-language intent → agent DAG → AP3X settlement</p>
        <h1 className="font-display text-4xl font-semibold uppercase tracking-wide mb-6">
          Conduct the <span className="text-accent">Vector</span> network
        </h1>

        <div className="panel p-5 space-y-4">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder='e.g. "Summarize today&apos;s Apex Fusion news and quote me a 90-day staking yield on 500 AP3X"'
            rows={4}
            className="w-full bg-void border border-line rounded-sm p-3 font-body text-sm focus:border-accent outline-none resize-none"
          />
          <div className="flex flex-wrap items-center gap-4">
            <label className="eyebrow flex items-center gap-2">
              Budget
              <input
                type="number"
                value={budget}
                min={1}
                onChange={(e) => setBudget(Number(e.target.value))}
                className="w-24 bg-void border border-line rounded-sm px-2 py-1 font-mono text-sm text-ink"
              />
              AP3X
            </label>
            <label className="eyebrow flex items-center gap-2">
              Mode
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as "auto" | "confirm")}
                className="bg-void border border-line rounded-sm px-2 py-1 font-mono text-sm text-ink"
              >
                <option value="confirm">confirm (review plan)</option>
                <option value="auto">auto</option>
              </select>
            </label>
            <button onClick={submit} disabled={busy || prompt.length === 0} className="btn-gold ml-auto">
              {busy ? "Planning…" : "Conduct"}
            </button>
          </div>
          {error && <p className="font-mono text-xs text-warn">{error}</p>}
        </div>

        {staticMode && (
          <div className="panel p-4 mt-4">
            <p className="eyebrow mb-2">
              Conductor node{" "}
              {nodeSaved ? (
                <span className="text-good">· connected: {nodeSaved}</span>
              ) : (
                <span className="text-accent">· browser demo mode — 6 virtual agents on live public APIs</span>
              )}
            </p>
            <div className="flex gap-2">
              <input
                value={nodeUrl}
                onChange={(e) => setNodeUrlState(e.target.value)}
                placeholder="https://your-conductor-node.example (cloudflared tunnel or hosted)"
                className="flex-1 bg-void border border-line rounded-sm px-3 py-2 font-mono text-xs focus:border-accent outline-none"
              />
              <button
                onClick={async () => {
                  setError(null);
                  const candidate = nodeUrl.trim().replace(/\/$/, "");
                  if (!/^https?:\/\//.test(candidate)) {
                    setError("node URL must start with http(s)://");
                    return;
                  }
                  try {
                    const res = await fetch(`${candidate}/health`, { signal: AbortSignal.timeout(5000) });
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                  } catch {
                    setError("node unreachable — check the URL (tunnels expire when the host machine stops). Demo mode keeps working without a node.");
                    return;
                  }
                  setNodeUrl(candidate);
                  setNodeSaved(getNodeUrl());
                }}
                className="btn-ghost"
              >
                {nodeSaved ? "Update" : "Connect"}
              </button>
              {nodeSaved && (
                <button
                  onClick={() => {
                    setNodeUrl(null);
                    setNodeSaved(null);
                    setNodeUrlState("");
                    setError(null);
                  }}
                  className="btn-ghost text-warn"
                >
                  Disconnect
                </button>
              )}
            </div>
            <p className="font-mono text-[10px] text-ink-3 mt-2">
              demo mode plans and executes in YOUR browser against live data (news · prices · bAP3X market · Vector chain ·
              staking · registry) with a simulated AP3X ledger — connect a node for on-chain registry agents and real
              payments (one-click deploy: see README)
            </p>
          </div>
        )}

        {view && (
          <div className="panel p-5 mt-6">
            <div className="flex items-center justify-between mb-4">
              <span className="eyebrow">Plan Card · {view.task.taskId.slice(0, 8)}</span>
              <span className={`font-mono text-xs uppercase tracking-wider ${statusColor(view.task.status)}`}>{view.task.status}</span>
            </div>

            <ul className="space-y-2">
              {(view.task.plan?.steps ?? []).map((planStep) => {
                const step = view.steps.find((s) => s.planStepId === planStep.id);
                return (
                  <li key={planStep.id} className="flex items-center gap-3 border-b border-line/50 pb-2">
                    <span className={`w-2 h-2 rounded-full ${dotColor(step?.status ?? "pending")}`} />
                    <span className="font-mono text-xs text-ink-3 w-24">{planStep.kind}</span>
                    <span className="font-body text-sm flex-1">
                      {planStep.capability ?? planStep.tool ?? planStep.id}
                      {step?.agentId && <span className="text-ink-3"> · {step.agentId.slice(0, 18)}</span>}
                    </span>
                    {step?.feePaidAp3x != null && <span className="font-mono text-xs text-accent">{step.feePaidAp3x} AP3X</span>}
                    <span className="font-mono text-[10px] text-ink-3 uppercase">{step?.status ?? "pending"}</span>
                  </li>
                );
              })}
              {!view.task.plan && <li className="font-mono text-xs text-ink-3">planning…</li>}
            </ul>

            {view.task.status === "awaiting_approval" && (
              <button onClick={approve} className="btn-gold mt-4">
                Approve &amp; execute
              </button>
            )}
            {view.task.error && <p className="font-mono text-xs text-warn mt-3">{view.task.error}</p>}
            {view.task.status === "complete" && <ResultPanel view={view} />}
            {view.task.anchorTx && (
              <p className="font-mono text-xs mt-3 text-ink-2">
                anchored:{" "}
                <a className="text-accent underline" href={EXPLORER_TX(view.task.anchorTx)} target="_blank" rel="noreferrer">
                  {view.task.anchorTx.slice(0, 24)}…
                </a>
              </p>
            )}
          </div>
        )}
      </section>

      <aside className="space-y-6">
        <div className="panel p-5">
          <p className="eyebrow mb-3">Budget meter</p>
          <div className="h-2 bg-void rounded-sm overflow-hidden border border-line">
            <div className="h-full bg-accent transition-all" style={{ width: `${budgetPct}%` }} />
          </div>
          <div className="flex justify-between mt-2 font-mono text-xs text-ink-2">
            <span>{spent.toFixed(2)} AP3X spent</span>
            <span>{view ? `${view.task.budgetAp3x} AP3X cap` : `${budget} AP3X cap`}</span>
          </div>
          {ap3xUsd !== null && (
            <p className="font-mono text-[10px] text-ink-3 mt-2">
              ≈ ${(spent * ap3xUsd).toFixed(2)} / ${((view?.task.budgetAp3x ?? budget) * ap3xUsd).toFixed(2)} USD · AP3X ${ap3xUsd}
            </p>
          )}
        </div>

        <div className="panel p-5">
          <p className="eyebrow mb-3">Ledger</p>
          {view && view.payments.length > 0 ? (
            <ul className="space-y-1 font-mono text-xs">
              {view.payments.map((p, i) => (
                <li key={i} className="flex justify-between">
                  <span className="text-ink-3">{p.kind}</span>
                  <span>
                    {p.amount} {p.asset}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="font-mono text-xs text-ink-3">no payments yet</p>
          )}
        </div>

        <div className="panel p-5">
          <p className="eyebrow mb-2">How it settles</p>
          <p className="font-body text-sm text-ink-2 leading-relaxed">
            Every task locks budget, pays verified agents in AP3X, skims a 2.5% protocol fee, and anchors an audit hash on
            Vector. Value-moving steps dry-run first; anything above the checkpoint needs your approval.
          </p>
        </div>
      </aside>
    </div>
  );
}

/** the aggregate step's output — the actual answer the network produced */
function ResultPanel({ view }: { view: TaskView }) {
  const aggregate = view.steps.find((s) => s.kind === "aggregate");
  const results = (aggregate?.output as { results?: Record<string, unknown> } | null)?.results;
  if (!results) return null;
  return (
    <div className="mt-4 border-t border-line pt-4">
      <p className="eyebrow mb-2 text-accent">Result</p>
      {Object.entries(results).map(([stepId, output]) => (
        <div key={stepId} className="mb-3">
          <p className="font-mono text-[10px] text-ink-3 mb-1">{stepId}</p>
          <StepResult output={output} />
        </div>
      ))}
    </div>
  );
}

function StepResult({ output }: { output: unknown }) {
  const o = output as {
    kind?: string;
    headlines?: Array<{ title: string; link: string; pubDate: string }>;
    summary?: string;
    topic?: string;
    source?: string;
    usd?: number | null;
    asset?: string;
    projectedYieldAp3x?: number;
  } | null;

  if (o?.kind === "news" && o.headlines) {
    return (
      <div className="space-y-2">
        {o.headlines.map((h, i) => (
          <a
            key={i}
            href={h.link}
            target="_blank"
            rel="noreferrer"
            className="block font-body text-sm text-ink hover:text-accent transition leading-snug"
          >
            <span className="text-accent mr-2">›</span>
            {h.title}
            {h.pubDate && <span className="font-mono text-[10px] text-ink-3 ml-2">{new Date(h.pubDate).toLocaleDateString()}</span>}
          </a>
        ))}
        <p className="font-mono text-[10px] text-ink-3">
          topic: {o.topic} · source: {o.source}
        </p>
      </div>
    );
  }
  if (o?.kind === "summary" && o.summary) {
    return <p className="font-body text-sm text-ink-2 leading-relaxed">{o.summary}</p>;
  }
  if (o?.kind === "price_quotes" && Array.isArray((o as { quotes?: unknown[] }).quotes)) {
    const quotes = (o as { quotes: Array<{ asset: string; usd: number; change24h: number | null }>; source?: string }).quotes;
    return (
      <div className="font-body text-sm text-ink-2 space-y-1">
        {quotes.map((q) => (
          <p key={q.asset}>
            {q.asset}: <span className="text-accent">${q.usd < 1 ? q.usd.toFixed(6) : q.usd.toLocaleString()}</span>
            {q.change24h !== null && (
              <span className={q.change24h >= 0 ? "text-good" : "text-warn"}> {q.change24h >= 0 ? "+" : ""}{q.change24h.toFixed(2)}% 24h</span>
            )}
          </p>
        ))}
        <p className="font-mono text-[10px] text-ink-3">source: {(o as { source?: string }).source}</p>
      </div>
    );
  }
  if (o?.kind === "market") {
    const m = o as unknown as { pool: string; priceUsd: number; volume24hUsd: number; reserveUsd: number; change24hPct: number; fdvUsd: number; source: string };
    return (
      <div className="font-body text-sm text-ink-2 space-y-1">
        <p>{m.pool}: <span className="text-accent">${m.priceUsd.toFixed(6)}</span>
          <span className={m.change24hPct >= 0 ? "text-good" : "text-warn"}> {m.change24hPct >= 0 ? "+" : ""}{m.change24hPct.toFixed(2)}% 24h</span>
        </p>
        <p>24h volume ${Math.round(m.volume24hUsd).toLocaleString()} · liquidity ${Math.round(m.reserveUsd).toLocaleString()} · FDV ${Math.round(m.fdvUsd).toLocaleString()}</p>
        <p className="font-mono text-[10px] text-ink-3">source: {m.source}</p>
      </div>
    );
  }
  if (o?.kind === "chain_stats") {
    const c = o as unknown as { chain: string; blockHeight: number; epoch: number; supplyAp3x: number | null; circulatingAp3x: number | null; lastBlock: string };
    return (
      <div className="font-body text-sm text-ink-2 space-y-1">
        <p>{c.chain} · block <span className="text-accent">{c.blockHeight.toLocaleString()}</span> · epoch {c.epoch}</p>
        {c.supplyAp3x && <p>supply {Math.round(c.supplyAp3x).toLocaleString()} AP3X{c.circulatingAp3x ? ` · circulating ${Math.round(c.circulatingAp3x).toLocaleString()}` : ""}</p>}
        <p className="font-mono text-[10px] text-ink-3">last block {new Date(c.lastBlock).toLocaleString()}</p>
      </div>
    );
  }
  if (o?.kind === "registry_stats") {
    const r = o as unknown as { totalAgents: number; registeredLast7d: number; note: string };
    return (
      <div className="font-body text-sm text-ink-2 space-y-1">
        <p><span className="text-accent">{r.totalAgents}</span> agents on the registry · {r.registeredLast7d} new in 7d</p>
        <p className="font-mono text-[10px] text-ink-3">{r.note}</p>
      </div>
    );
  }
  if (o?.kind === "price_quote") {
    return (
      <p className="font-body text-sm text-ink-2">
        {o.asset}: {o.usd !== null && o.usd !== undefined ? `$${o.usd}` : "unavailable"} <span className="text-ink-3">({o.source})</span>
      </p>
    );
  }
  if (o?.kind === "stake_quote" && o.projectedYieldAp3x !== undefined) {
    return <p className="font-body text-sm text-ink-2">projected yield: {o.projectedYieldAp3x} AP3X</p>;
  }
  return (
    <pre className="bg-void border border-line rounded-sm p-3 font-mono text-[11px] text-ink-2 overflow-x-auto whitespace-pre-wrap max-h-64">
      {JSON.stringify(output, null, 2)}
    </pre>
  );
}

function statusColor(status: string): string {
  if (status === "complete") return "text-good";
  if (status === "failed") return "text-warn";
  if (status === "awaiting_approval") return "text-accent";
  return "text-ink-2";
}

function dotColor(status: string): string {
  if (status === "complete") return "bg-good";
  if (status === "failed" || status === "skipped") return "bg-warn";
  if (status === "running" || status === "awaiting_approval") return "bg-accent animate-pulse";
  return "bg-line";
}
