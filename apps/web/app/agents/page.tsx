"use client";

import { useEffect, useState } from "react";
import { listAgents, type AgentView } from "@/lib/api";

/** registry smoke/lifecycle test entries — real on-chain, but noise for the marketplace */
const TEST_AGENT_PATTERN = /smoke|juror|sybil|lifecycle|test_/i;

function isShowcase(agent: AgentView): boolean {
  if (agent.routable) return true;
  if (TEST_AGENT_PATTERN.test(agent.name)) return false;
  return agent.capabilities.length > 0;
}

/** routable first, then named+capable, richest capability sets up front */
function rank(a: AgentView, b: AgentView): number {
  if (a.routable !== b.routable) return a.routable ? -1 : 1;
  if (a.capabilities.length !== b.capabilities.length) return b.capabilities.length - a.capabilities.length;
  return a.name.localeCompare(b.name);
}

/** SPEC §5.5 `/agents` — marketplace over the indexed registry catalog. */
export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentView[] | null>(null);
  const [capability, setCapability] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showTestAgents, setShowTestAgents] = useState(false);

  const load = (cap?: string) => {
    listAgents(cap || undefined)
      .then(setAgents)
      .catch((err) => setError((err as Error).message));
  };

  useEffect(() => load(), []);

  const showcase = (agents ?? []).filter(isShowcase).sort(rank);
  const testAgents = (agents ?? []).filter((a) => !isShowcase(a)).sort(rank);
  const visible = showTestAgents ? [...showcase, ...testAgents] : showcase;

  return (
    <div>
      <p className="eyebrow mb-2">On-chain Vector Agent Registry · policy be1a0a29…2c01</p>
      <h1 className="font-display text-4xl font-semibold uppercase tracking-wide mb-6">
        Agent <span className="text-accent">marketplace</span>
      </h1>

      <div className="flex gap-3 mb-6">
        <input
          value={capability}
          onChange={(e) => setCapability(e.target.value)}
          placeholder="filter by capability (e.g. news, staking, price)"
          className="bg-void border border-line rounded-sm px-3 py-2 font-mono text-xs w-80 focus:border-accent outline-none"
        />
        <button onClick={() => load(capability)} className="btn-ghost">
          Filter
        </button>
      </div>

      {error && (
        <p className="font-mono text-xs text-warn mb-4">
          {error} — registry temporarily unreachable (Koios and any connected node both failed); retry in a moment
        </p>
      )}

      <div className="panel overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-line">
              {["Agent", "Capabilities", "Price", "Stake", "Reputation", "Endpoint", "Status"].map((h) => (
                <th key={h} className="eyebrow px-4 py-3 font-normal">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((agent) => (
              <tr key={agent.agentId} className="border-b border-line/40 hover:bg-void/40">
                <td className="px-4 py-3">
                  <div className="font-display font-semibold">{agent.name}</div>
                  <div className="font-mono text-[10px] text-ink-3">{agent.agentId.slice(0, 32)}…</div>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {agent.capabilities.map((c) => (
                      <span key={c} className="font-mono text-[10px] uppercase border border-line rounded-sm px-1.5 py-0.5 text-ink-2">
                        {c}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3 font-mono text-xs text-accent">
                  {agent.pricing ? (
                    <>
                      {agent.pricing.amountAp3x} <span className="text-ink-3">AP3X/{agent.pricing.model.replace("per_", "")}</span>
                    </>
                  ) : (
                    <span className="text-ink-3">—</span>
                  )}
                </td>
                <td className="px-4 py-3 font-mono text-xs">{agent.stakeAp3x}</td>
                <td className="px-4 py-3">
                  <div className="w-20 h-1.5 bg-void border border-line rounded-sm overflow-hidden">
                    <div className="h-full bg-accent" style={{ width: `${agent.reputation.score * 100}%` }} />
                  </div>
                  <span className="font-mono text-[10px] text-ink-3">
                    {(agent.reputation.score * 100).toFixed(0)} · {agent.reputation.tasks} tasks
                  </span>
                </td>
                <td className="px-4 py-3 font-mono text-[10px] text-ink-3">
                  {agent.endpoint ? agent.endpoint.type : <span className="text-warn">none (manifest needed)</span>}
                  {agent.source?.endpoint === "manifest" && <span className="text-warn"> (manifest)</span>}
                </td>
                <td className="px-4 py-3">
                  <span className={`font-mono text-[10px] uppercase ${agent.status === "active" ? "text-good" : "text-warn"}`}>
                    {agent.status}
                  </span>
                </td>
              </tr>
            ))}
            {agents !== null && visible.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center font-mono text-xs text-ink-3">
                  no agents indexed yet — the indexer polls the registry every 60s
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {testAgents.length > 0 && (
          <button
            onClick={() => setShowTestAgents(!showTestAgents)}
            className="w-full py-3 border-t border-line font-mono text-[10px] uppercase tracking-[0.18em] text-ink-3 hover:text-accent transition"
          >
            {showTestAgents ? "▲ hide" : "▼ show"} {testAgents.length} registry smoke-test agents (lifecycle / juror / sybil drills)
          </button>
        )}
      </div>
      {agents !== null && (
        <p className="font-mono text-[10px] text-ink-3 mt-3">
          {agents.length} agents on-chain · {showcase.length} in marketplace · {agents.filter((a) => a.routable).length} routable
          (live datums carry no endpoint — operators add one via a signed manifest or re-registration)
        </p>
      )}
    </div>
  );
}
