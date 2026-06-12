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

/**
 * News agent — fetches live headlines from Google News RSS (a toolkit connector) for the
 * intent topic; falls back to extractive summarization of provided text. No LLM dependency.
 */
export const NewsSummarizerAgent: DemoAgent = {
  name: "NewsSummarizerAgent",
  capabilities: ["news", "summarize", "research"],
  priceAp3x: 2,
  async handle(input) {
    // a document (text/article/content) is summarized offline; a bare intent is a news QUERY
    const doc = extractDoc(input);
    const query = doc ? null : findStringKey(input, "intent");
    const text = doc ?? query ?? extractText(input) ?? "";
    const topic = doc ? null : newsTopic(text);
    if (topic) {
      try {
        const res = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=en-US&gl=US&ceid=US:en`, {
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const xml = await res.text();
          const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 5).map((m) => {
            const block = m[1]!;
            const title = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1]?.trim() ?? "";
            const link = block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() ?? "";
            const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() ?? "";
            return { title: decodeXml(title), link, pubDate };
          });
          if (items.length > 0) {
            return {
              kind: "news",
              topic,
              headline: items[0]!.title,
              headlines: items,
              source: "Google News RSS",
              fetchedAt: new Date().toISOString(),
            };
          }
        }
      } catch {
        /* fall through to extractive summary */
      }
    }
    const sentences = text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 20);
    const summary = sentences.slice(0, 3).join(" ") || text.slice(0, 280);
    return { kind: "summary", headline: summary.slice(0, 120) || "(empty input)", summary, sentenceCount: sentences.length };
  },
};

const STOPWORDS = new Set(
  "what is are was were the a an on in of for to and or going goin happening happens latest news about update updates current today now tell me show find get".split(" "),
);

/** pull a search topic out of a news-shaped intent; null if the input is a text blob to summarize */
function newsTopic(text: string): string | null {
  if (text.length > 400) return null; // long input = document to summarize, not a query
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  return words.length > 0 ? words.slice(0, 6).join(" ") : null;
}

/** document payloads (to summarize) come under text/article/content keys */
function extractDoc(input: unknown, depth = 0): string | null {
  if (depth > 3 || !input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  for (const key of ["text", "article", "content"]) {
    if (typeof o[key] === "string") return o[key] as string;
  }
  for (const value of Object.values(o)) {
    const nested = extractDoc(value, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function findStringKey(input: unknown, key: string, depth = 0): string | null {
  if (depth > 3 || !input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  if (typeof o[key] === "string") return o[key] as string;
  for (const value of Object.values(o)) {
    const nested = findStringKey(value, key, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

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
