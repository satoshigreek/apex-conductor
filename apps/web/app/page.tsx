"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { approveTask, getTask, submitIntent, COINGECKO_AP3X, EXPLORER_TX, type TaskView } from "@/lib/api";

/** SPEC §5.5 `/` — Conductor chat: Plan Card (DAG checklist), approval buttons, live budget meter. */
export default function ConductorPage() {
  const [prompt, setPrompt] = useState("");
  const [budget, setBudget] = useState(50);
  const [mode, setMode] = useState<"auto" | "confirm">("confirm");
  const [view, setView] = useState<TaskView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ap3xUsd, setAp3xUsd] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
      setError((err as Error).message);
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
          Conduct the <span className="text-gold">Vector</span> network
        </h1>

        <div className="panel p-5 space-y-4">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder='e.g. "Summarize today&apos;s Apex Fusion news and quote me a 90-day staking yield on 500 AP3X"'
            rows={4}
            className="w-full bg-void border border-line rounded-sm p-3 font-body text-sm focus:border-gold outline-none resize-none"
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
                    {step?.feePaidAp3x != null && <span className="font-mono text-xs text-gold">{step.feePaidAp3x} AP3X</span>}
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
            {view.task.anchorTx && (
              <p className="font-mono text-xs mt-3 text-ink-2">
                anchored:{" "}
                <a className="text-gold underline" href={EXPLORER_TX(view.task.anchorTx)} target="_blank" rel="noreferrer">
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
            <div className="h-full bg-gold transition-all" style={{ width: `${budgetPct}%` }} />
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

function statusColor(status: string): string {
  if (status === "complete") return "text-good";
  if (status === "failed") return "text-warn";
  if (status === "awaiting_approval") return "text-gold";
  return "text-ink-2";
}

function dotColor(status: string): string {
  if (status === "complete") return "bg-good";
  if (status === "failed" || status === "skipped") return "bg-warn";
  if (status === "running" || status === "awaiting_approval") return "bg-gold animate-pulse";
  return "bg-line";
}
