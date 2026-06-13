"use client";

import { useState } from "react";

/**
 * Layer 6 of the Apex Fusion connector architecture — AI CLIENTS.
 * Clients are the DEMAND side: where a human or LLM forms an intent. Registry agents
 * are the SUPPLY side. Conductor sits between: clients reach it via the MCP tool
 * `conduct(intent, budgetAp3x)`, the REST/SSE API, or this web chat (the Fusion AI slot);
 * Conductor discovers agents on-chain, routes by score, pays in AP3X after verification,
 * and anchors the audit trail. Clients never pay agents directly.
 */
interface ClientCard {
  name: string;
  kind: string;
  path: "MCP" | "REST" | "SDK" | "Web";
  blurb: string;
  snippet: string;
  snippetLabel: string;
}

const CONDUCTOR_MCP = "http://localhost:4000/mcp/sse";
const CONDUCTOR_API = "http://localhost:4000";

const CLIENTS: ClientCard[] = [
  {
    name: "Claude / Claude Desktop",
    kind: "Anthropic — MCP-native",
    path: "MCP",
    blurb:
      "Add Conductor as an MCP server and Claude gains the conduct() tool: it plans nothing itself — it states the intent and budget, Conductor orchestrates the agent DAG and returns the verified result with the anchor tx.",
    snippetLabel: "claude_desktop_config.json",
    snippet: `{
  "mcpServers": {
    "apex-conductor": {
      "url": "${CONDUCTOR_MCP}"
    }
  }
}`,
  },
  {
    name: "GPT / Gemini (any MCP client)",
    kind: "OpenAI / Google — via MCP",
    path: "MCP",
    blurb:
      "Any MCP-capable runtime (OpenAI Agents SDK, Gemini CLI, Cursor, …) connects to the same SSE endpoint and sees the same single tool. One integration surface for every model vendor.",
    snippetLabel: "MCP server entry",
    snippet: `{
  "name": "apex-conductor",
  "transport": "sse",
  "url": "${CONDUCTOR_MCP}",
  "tools": ["conduct"]
}`,
  },
  {
    name: "LangChain",
    kind: "Python agent framework",
    path: "SDK",
    blurb:
      "Wrap the REST API as a LangChain tool (or use agent-sdk-py for raw chain access). Your chain decides WHEN to orchestrate; Conductor decides HOW — routing, payment, verification.",
    snippetLabel: "Python",
    snippet: `from langchain_core.tools import tool
import requests

@tool
def conduct(intent: str, budget_ap3x: float) -> dict:
    """Orchestrate specialists on the Vector agent network."""
    r = requests.post("${CONDUCTOR_API}/v1/intents",
        json={"prompt": intent, "budgetAp3x": budget_ap3x, "mode": "auto"})
    return r.json()  # poll /v1/tasks/{taskId} for the result`,
  },
  {
    name: "CrewAI",
    kind: "Python multi-agent framework",
    path: "SDK",
    blurb:
      "A crew member delegates to the on-chain network for capabilities the crew lacks — e.g. anything needing staked, reputation-scored, paid execution with an audit trail.",
    snippetLabel: "Python",
    snippet: `from crewai.tools import tool
import requests

@tool("Vector network orchestration")
def conduct(intent: str, budget_ap3x: float = 20) -> str:
    r = requests.post("${CONDUCTOR_API}/v1/intents",
        json={"prompt": intent, "budgetAp3x": budget_ap3x, "mode": "auto"})
    return r.json()["taskId"]`,
  },
  {
    name: "OpenClaw",
    kind: "Open agent runtime — MCP",
    path: "MCP",
    blurb:
      "Connects like any MCP client; spend safety is enforced server-side (per-task / daily caps, dry-run gates, human checkpoints), so an autonomous runtime can hold conduct() without holding keys.",
    snippetLabel: "MCP config",
    snippet: `mcp:
  servers:
    apex-conductor:
      url: ${CONDUCTOR_MCP}`,
  },
  {
    name: "Fusion AI (Hub chat)",
    kind: "First-party web surface",
    path: "Web",
    blurb:
      "That's this app — the Conductor tab is the Fusion AI slot of the architecture: chat in, Plan Card + budget meter + ledger out. Same REST/SSE API underneath as every other client.",
    snippetLabel: "REST (what this UI calls)",
    snippet: `POST ${CONDUCTOR_API}/v1/intents
  {"prompt": "...", "budgetAp3x": 50, "mode": "confirm"}
GET  ${CONDUCTOR_API}/v1/tasks/:id          # plan, steps, payments
GET  ${CONDUCTOR_API}/v1/tasks/:id/events   # SSE stream`,
  },
];

export default function ClientsPage() {
  const [open, setOpen] = useState<string | null>(CLIENTS[0]!.name);

  return (
    <div>
      <p className="eyebrow mb-2">Layer 6 — AI clients · one orchestrator, three doors: MCP · REST/SSE · web</p>
      <h1 className="font-display text-4xl font-semibold uppercase tracking-wide mb-6">
        Connect a <span className="text-accent">client</span>
      </h1>

      <div className="panel p-5 mb-8">
        <p className="font-body text-sm text-ink-2 leading-relaxed">
          <span className="text-ink font-semibold">Clients are the demand side; agents are the supply side.</span> A client
          (Claude, GPT, a LangChain app, this chat) states an intent and a budget. Conductor discovers specialists in the
          on-chain registry, plans the DAG, routes by reputation/price/stake, pays in AP3X <em>after verification</em>, and
          anchors the audit summary on Vector. Clients never talk to agents or hold AP3X directly — every client call becomes
          escrow + fees + anchor on-chain.
        </p>
        <p className="font-mono text-[10px] text-ink-3 mt-3 tracking-wider">
          CLIENT → conduct(intent, budget) → CONDUCTOR → registry discovery → agent calls → verify → pay → anchor
        </p>
      </div>

      <div className="space-y-3">
        {CLIENTS.map((client) => (
          <div key={client.name} className="panel">
            <button
              onClick={() => setOpen(open === client.name ? null : client.name)}
              className="w-full flex items-center gap-4 px-5 py-4 text-left"
            >
              <span className="font-display font-semibold text-lg flex-1">{client.name}</span>
              <span className="font-mono text-[10px] uppercase tracking-wider text-ink-3 hidden sm:inline">{client.kind}</span>
              <span className="font-mono text-[10px] uppercase border border-line rounded-sm px-2 py-0.5 text-accent">{client.path}</span>
              <span className="font-mono text-xs text-ink-3">{open === client.name ? "▲" : "▼"}</span>
            </button>
            {open === client.name && (
              <div className="px-5 pb-5 border-t border-line/50 pt-4">
                <p className="font-body text-sm text-ink-2 leading-relaxed mb-4">{client.blurb}</p>
                <p className="eyebrow mb-1">{client.snippetLabel}</p>
                <pre className="bg-void border border-line rounded-sm p-4 font-mono text-xs text-ink-2 overflow-x-auto whitespace-pre">
                  {client.snippet}
                </pre>
              </div>
            )}
          </div>
        ))}
      </div>

      <p className="font-mono text-[10px] text-ink-3 mt-6">
        endpoints shown for local dev — swap the host for your deployment · MCP surface lives in services/conductor (SSE at
        /mcp/sse) · spend caps, dry-run gates and checkpoints are enforced server-side for every client equally
      </p>
    </div>
  );
}
