import { AgentProfileSchema, type AgentProfile } from "@apex/core";
import type { AgentRow, AgentStore } from "./store/index.js";

/**
 * SPEC §4.1 / BLOCKER-3 — AgentProfileResolver.
 * Merges the on-chain datum row with a signed off-chain manifest when the datum
 * lacks `endpoint`/`pricing`. Datum audit (docs/datum-audit.md) decides which path is primary.
 */
export interface ResolvedAgent {
  profile: AgentProfile;
  source: { endpoint: "datum" | "manifest" | "missing"; pricing: "datum" | "manifest" | "missing" };
  row: AgentRow;
}

const ENDPOINT_TYPES = new Set(["mcp-sse", "https", "a2a"]);
const PRICING_MODELS = new Set(["per_call", "per_token", "subscription"]);

export async function resolveAgent(store: AgentStore, row: AgentRow): Promise<ResolvedAgent | null> {
  const manifest = await store.getManifest(row.agentId);

  let endpoint: AgentProfile["endpoint"] | null = null;
  let endpointSource: ResolvedAgent["source"]["endpoint"] = "missing";
  if (row.endpointUrl) {
    const type = row.endpointType && ENDPOINT_TYPES.has(row.endpointType) ? row.endpointType : "https";
    endpoint = { type: type as AgentProfile["endpoint"]["type"], url: row.endpointUrl };
    endpointSource = "datum";
  } else if (manifest?.verified) {
    endpoint = manifest.endpoint;
    endpointSource = "manifest";
  }

  let pricing: AgentProfile["pricing"] | null = null;
  let pricingSource: ResolvedAgent["source"]["pricing"] = "missing";
  if (row.priceAp3x !== null) {
    const model = row.pricingModel && PRICING_MODELS.has(row.pricingModel) ? row.pricingModel : "per_call";
    pricing = { model: model as AgentProfile["pricing"]["model"], amountAp3x: row.priceAp3x };
    pricingSource = "datum";
  } else if (manifest?.verified) {
    pricing = manifest.pricing;
    pricingSource = "manifest";
  }

  // unroutable without an endpoint; pricing defaults to free-quote (0) but is flagged missing
  if (!endpoint) return null;

  const candidate = {
    agentId: row.agentId,
    name: row.name ?? row.agentId,
    capabilities: row.capabilities,
    endpoint,
    pricing: pricing ?? { model: "per_call" as const, amountAp3x: 0 },
    stakeAp3x: row.stakeAp3x ?? 0,
    ownerPkh: row.ownerPkh ?? "",
    registeredTx: row.registeredTx ?? "",
    reputation: { score: row.reputation, tasks: row.repTasks, disputes: row.repDisputes },
  };
  const parsed = AgentProfileSchema.safeParse(candidate);
  if (!parsed.success) return null;
  return { profile: parsed.data, source: { endpoint: endpointSource, pricing: pricingSource }, row };
}

export async function resolveAll(store: AgentStore, filter?: { capability?: string }): Promise<ResolvedAgent[]> {
  const rows = await store.listAgents(filter);
  const out: ResolvedAgent[] = [];
  for (const row of rows) {
    const resolved = await resolveAgent(store, row);
    if (resolved) out.push(resolved);
  }
  return out;
}

/**
 * Full catalog listing for GET /v1/agents — includes agents the live datum leaves
 * unroutable (no endpoint, BLOCKER-3); the router itself only sees resolveAll().
 */
export interface CatalogEntry {
  agentId: string;
  name: string;
  capabilities: string[];
  endpoint: { type: string; url: string } | null;
  pricing: { model: string; amountAp3x: number } | null;
  stakeAp3x: number;
  ownerPkh: string;
  registeredTx: string;
  reputation: { score: number; tasks: number; disputes: number };
  status: string;
  routable: boolean;
  source: ResolvedAgent["source"] | null;
}

export async function listCatalog(store: AgentStore, filter?: { capability?: string }): Promise<CatalogEntry[]> {
  const rows = await store.listAgents(filter);
  const out: CatalogEntry[] = [];
  for (const row of rows) {
    const resolved = await resolveAgent(store, row);
    if (resolved) {
      out.push({
        ...resolved.profile,
        endpoint: resolved.profile.endpoint,
        pricing: resolved.profile.pricing,
        status: row.status,
        routable: true,
        source: resolved.source,
      });
    } else {
      out.push({
        agentId: row.agentId,
        name: row.name ?? row.agentId,
        capabilities: row.capabilities,
        endpoint: null,
        pricing: row.priceAp3x !== null ? { model: row.pricingModel ?? "per_call", amountAp3x: row.priceAp3x } : null,
        stakeAp3x: row.stakeAp3x ?? 0,
        ownerPkh: row.ownerPkh ?? "",
        registeredTx: row.registeredTx ?? "",
        reputation: { score: row.reputation, tasks: row.repTasks, disputes: row.repDisputes },
        status: row.status,
        routable: false,
        source: null,
      });
    }
  }
  return out;
}
