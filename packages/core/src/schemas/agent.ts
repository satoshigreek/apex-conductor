import { z } from "zod";

/** SPEC §4.1 — AgentProfile, normalized from registry datum (+ manifest fallback, BLOCKER-3). */
export const EndpointSchema = z.object({
  type: z.enum(["mcp-sse", "https", "a2a"]),
  url: z.string().url(),
});

export const PricingSchema = z.object({
  model: z.enum(["per_call", "per_token", "subscription"]),
  amountAp3x: z.number().nonnegative(),
});

export const AgentProfileSchema = z.object({
  agentId: z.string().min(1),
  name: z.string().min(1),
  capabilities: z.array(z.string().min(1)),
  endpoint: EndpointSchema,
  pricing: PricingSchema,
  stakeAp3x: z.number().nonnegative(),
  /** may be empty when the datum doesn't carry it (BLOCKER-3) — such agents are listable but unpayable */
  ownerPkh: z.string(),
  registeredTx: z.string(),
  reputation: z.object({
    score: z.number().min(0).max(1),
    tasks: z.number().int().nonnegative(),
    disputes: z.number().int().nonnegative(),
  }),
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

/** Partial profile decodable from the on-chain datum alone (endpoint/pricing may be absent — BLOCKER-3). */
export const OnChainAgentSchema = AgentProfileSchema.partial({
  endpoint: true,
  pricing: true,
}).extend({
  raw: z.unknown().optional(),
});
export type OnChainAgent = z.infer<typeof OnChainAgentSchema>;

/** Signed off-chain manifest an operator POSTs to fill datum gaps; signature must verify against ownerPkh. */
export const AgentManifestSchema = z.object({
  agentId: z.string().min(1),
  endpoint: EndpointSchema,
  pricing: PricingSchema,
  signature: z.string().min(1),
  publicKey: z.string().min(1),
});
export type AgentManifest = z.infer<typeof AgentManifestSchema>;

export const AgentStatusSchema = z.enum(["active", "stale", "cooldown"]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
