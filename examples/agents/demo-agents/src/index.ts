import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

/**
 * SPEC M2 — three first-party demo agents. Each serves an `https` endpoint with
 * GET /health (heartbeat prober) and POST / ({input} → output).
 *
 * TODO(M2-registration): self-registration on the TESTNET registry via agent-sdk-ts
 * (faucet-funded wallet, datum per docs/datum-audit.md / vector-ai-agents DEPLOY.md).
 * Until the SDK wallet lands, register manually or via an off-chain manifest.
 */
export interface DemoAgent {
  name: string;
  capabilities: string[];
  priceAp3x: number;
  handle(input: unknown): Promise<unknown>;
}

const stakeInput = z.object({ amountAp3x: z.number().positive().default(100), days: z.number().int().positive().default(30) });

/** Prime liquid-staking quote: ~10% APY, no lockups (toolkit: cstAP3X mirror). */
export const StakerAgent: DemoAgent = {
  name: "StakerAgent",
  capabilities: ["staking", "stake-quote"],
  priceAp3x: 1,
  async handle(input) {
    const parsed = stakeInput.safeParse((input as { input?: { results?: unknown } })?.input ?? input ?? {});
    const { amountAp3x, days } = parsed.success ? parsed.data : { amountAp3x: 100, days: 30 };
    const apy = 0.1;
    const yieldAp3x = amountAp3x * (Math.pow(1 + apy, days / 365) - 1);
    return {
      kind: "stake_quote",
      amountAp3x,
      days,
      apy,
      projectedYieldAp3x: Number(yieldAp3x.toFixed(6)),
      note: "Prime liquid staking ~10% APY, no lockups; unstake on demand for gas",
    };
  },
};

/** Extractive summarizer — deterministic, no LLM dependency, ideal for E2E tests. */
export const NewsSummarizerAgent: DemoAgent = {
  name: "NewsSummarizerAgent",
  capabilities: ["news", "summarize"],
  priceAp3x: 2,
  async handle(input) {
    const text = extractText(input) ?? "";
    const sentences = text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 20);
    const summary = sentences.slice(0, 3).join(" ") || text.slice(0, 280);
    return { kind: "summary", headline: summary.slice(0, 120) || "(empty input)", summary, sentenceCount: sentences.length };
  },
};

/** AP3X price quote — CoinGecko when reachable, deterministic fallback otherwise. */
export const PriceQuoteAgent: DemoAgent = {
  name: "PriceQuoteAgent",
  capabilities: ["price", "quote"],
  priceAp3x: 1,
  async handle() {
    try {
      const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=apex-fusion&vs_currencies=usd", {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const body = (await res.json()) as Record<string, { usd?: number }>;
        const usd = body["apex-fusion"]?.usd;
        if (typeof usd === "number") return { kind: "price_quote", asset: "AP3X", usd, source: "coingecko" };
      }
    } catch {
      /* fall through to offline quote */
    }
    return { kind: "price_quote", asset: "AP3X", usd: null, source: "unavailable", note: "CoinGecko unreachable" };
  },
};

function extractText(input: unknown): string | null {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const key of ["text", "article", "content", "intent", "args", "input"]) {
      const v = o[key];
      if (typeof v === "string") return v;
      if (v && typeof v === "object") {
        const nested = extractText(v);
        if (nested) return nested;
      }
    }
  }
  return null;
}

export function buildAgentServer(agent: DemoAgent): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get("/health", async () => ({ ok: true, agent: agent.name, capabilities: agent.capabilities }));
  app.post("/", async (req) => agent.handle(req.body));
  return app;
}

export const ALL_AGENTS = [StakerAgent, NewsSummarizerAgent, PriceQuoteAgent];
