/**
 * Virtual agents — browser-executable specialists backed by live public APIs (all CORS-open).
 * They power demo mode on GitHub Pages: no server, no tunnel, real data. A connected
 * conductor node replaces them with on-chain registry agents and real payments.
 */
export interface VirtualAgent {
  agentId: string;
  name: string;
  capabilities: string[];
  priceAp3x: number;
  description: string;
  run(intent: string): Promise<unknown>;
}

const BAP3X_POOL = "0x5b8bf0cd0fa5bf970ebe558d7551a668dadf3570"; // Aerodrome bAP3X/USDC 0.05%
const KOIOS = "https://koios.vector.apexfusion.org/api/v1";

const STOPWORDS = new Set(
  "what is are was were the a an on in of for to and or going goin happening happens latest news about update updates current today now tell me show find get give my how much many".split(" "),
);

function topic(intent: string): string {
  return intent
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .slice(0, 6)
    .join(" ");
}

export const NewsAgent: VirtualAgent = {
  agentId: "virtual:news",
  name: "NewsAgent",
  capabilities: ["news", "research", "summarize"],
  priceAp3x: 2,
  description: "Live headlines for any topic (Google News via rss2json)",
  async run(intent) {
    const q = topic(intent) || "apex fusion crypto";
    const res = await fetch(
      `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`)}`,
    );
    if (!res.ok) throw new Error(`rss2json ${res.status}`);
    const body = (await res.json()) as { items?: Array<{ title: string; link: string; pubDate: string }> };
    const headlines = (body.items ?? []).slice(0, 5).map((i) => ({ title: i.title, link: i.link, pubDate: i.pubDate }));
    if (headlines.length === 0) throw new Error("no headlines found");
    return { kind: "news", topic: q, headline: headlines[0]!.title, headlines, source: "Google News (rss2json)", fetchedAt: new Date().toISOString() };
  },
};

const COIN_IDS: Record<string, string> = {
  ap3x: "apex-fusion", apex: "apex-fusion", bitcoin: "bitcoin", btc: "bitcoin",
  ethereum: "ethereum", eth: "ethereum", cardano: "cardano", ada: "cardano", solana: "solana", sol: "solana",
};

export const PriceAgent: VirtualAgent = {
  agentId: "virtual:price",
  name: "PriceAgent",
  capabilities: ["price", "quote"],
  priceAp3x: 1,
  description: "Spot prices (CoinGecko) — AP3X, BTC, ETH, ADA, SOL",
  async run(intent) {
    const words = intent.toLowerCase().split(/[^a-z0-9]+/);
    const ids = [...new Set(words.map((w) => COIN_IDS[w]).filter(Boolean))] as string[];
    if (ids.length === 0) ids.push("apex-fusion");
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd&include_24hr_change=true`);
    const body = res.ok ? ((await res.json()) as Record<string, { usd: number; usd_24h_change?: number }>) : {};
    let quotes = Object.entries(body).map(([id, q]) => ({ asset: id, usd: q.usd, change24h: q.usd_24h_change ?? null }));
    let source = "CoinGecko";
    if (quotes.length === 0) {
      // CoinGecko soft rate-limit returns 200 {} — fall back to the live pool price
      const gt = await fetch(`https://api.geckoterminal.com/api/v2/networks/base/pools/${BAP3X_POOL}`);
      if (!gt.ok) throw new Error("coingecko rate-limited and geckoterminal unavailable");
      const a = ((await gt.json()) as { data: { attributes: { base_token_price_usd: string; price_change_percentage?: { h24?: string } } } }).data.attributes;
      quotes = [{ asset: "apex-fusion (bAP3X pool)", usd: Number(a.base_token_price_usd), change24h: Number(a.price_change_percentage?.h24 ?? 0) }];
      source = "GeckoTerminal (CoinGecko rate-limited)";
    }
    return { kind: "price_quotes", quotes, source, fetchedAt: new Date().toISOString() };
  },
};

export const MarketAgent: VirtualAgent = {
  agentId: "virtual:market",
  name: "MarketAgent",
  capabilities: ["market", "analytics", "liquidity", "volume"],
  priceAp3x: 2,
  description: "bAP3X/USDC pool analytics on Base (GeckoTerminal)",
  async run() {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/base/pools/${BAP3X_POOL}`);
    if (!res.ok) throw new Error(`geckoterminal ${res.status}`);
    const a = ((await res.json()) as { data: { attributes: Record<string, unknown> } }).data.attributes;
    return {
      kind: "market",
      pool: a.name,
      priceUsd: Number(a.base_token_price_usd),
      fdvUsd: Number(a.fdv_usd),
      marketCapUsd: a.market_cap_usd ? Number(a.market_cap_usd) : null,
      volume24hUsd: Number((a.volume_usd as { h24?: string })?.h24 ?? 0),
      reserveUsd: Number(a.reserve_in_usd ?? 0),
      change24hPct: Number((a.price_change_percentage as { h24?: string })?.h24 ?? 0),
      source: "GeckoTerminal · Aerodrome Slipstream",
      fetchedAt: new Date().toISOString(),
    };
  },
};

export const VectorChainAgent: VirtualAgent = {
  agentId: "virtual:chain",
  name: "VectorChainAgent",
  capabilities: ["chain", "stats", "data_analysis", "network"],
  priceAp3x: 1,
  description: "Live Vector L2 chain stats (Koios)",
  async run() {
    const [tipRes, totalsRes] = await Promise.all([
      fetch(`${KOIOS}/tip`, { headers: { accept: "application/json" } }),
      fetch(`${KOIOS}/totals`, { headers: { accept: "application/json" } }),
    ]);
    if (!tipRes.ok) throw new Error(`koios tip ${tipRes.status}`);
    const tip = ((await tipRes.json()) as Array<{ block_no: number; epoch_no: number; block_time: number }>)[0]!;
    const totals = totalsRes.ok ? ((await totalsRes.json()) as Array<{ supply?: string; circulation?: string }>)[0] : null;
    return {
      kind: "chain_stats",
      chain: "Vector L2 (mainnet)",
      blockHeight: tip.block_no,
      epoch: tip.epoch_no,
      lastBlock: new Date(tip.block_time * 1000).toISOString(),
      supplyAp3x: totals?.supply ? Number(totals.supply) / 1e6 : null,
      circulatingAp3x: totals?.circulation ? Number(totals.circulation) / 1e6 : null,
      source: "Koios (Vector mainnet)",
    };
  },
};

export const StakingAgent: VirtualAgent = {
  agentId: "virtual:staking",
  name: "StakingAgent",
  capabilities: ["staking", "stake-quote", "yield"],
  priceAp3x: 1,
  description: "Prime liquid-staking yield projections (~10% APY, no lockups)",
  async run(intent) {
    const amount = Number(intent.match(/([\d,]+(?:\.\d+)?)\s*(?:ap3x|apex)/i)?.[1]?.replace(/,/g, "") ?? intent.match(/([\d,]{3,})/)?.[1]?.replace(/,/g, "") ?? 1000);
    const days = Number(intent.match(/(\d+)\s*(?:day|d\b)/i)?.[1] ?? (intent.match(/(\d+)\s*(?:month|mo)/i ) ? Number(intent.match(/(\d+)\s*(?:month|mo)/i)![1]) * 30 : 365));
    const apy = 0.1;
    const projected = amount * (Math.pow(1 + apy, days / 365) - 1);
    return {
      kind: "stake_quote",
      amountAp3x: amount,
      days,
      apy,
      projectedYieldAp3x: Number(projected.toFixed(4)),
      note: "Prime liquid staking ~10% APY, unstake on demand for gas (cstAP3X mirror)",
    };
  },
};

export const RegistryAgent: VirtualAgent = {
  agentId: "virtual:registry",
  name: "RegistryAgent",
  capabilities: ["registry", "agents", "governance"],
  priceAp3x: 1,
  description: "On-chain Agent Registry analytics (Koios)",
  async run() {
    const res = await fetch(`${KOIOS}/address_utxos`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ _addresses: ["addr1wxlp5z3fztdpsp6ha57dvx6khw82kqvgcxwu8s8rjykjcqghprf42"], _extended: false }),
    });
    if (!res.ok) throw new Error(`koios ${res.status}`);
    const utxos = (await res.json()) as Array<{ block_time?: number }>;
    const week = 7 * 24 * 3600;
    const now = Math.floor(Date.now() / 1000);
    const lastWeek = utxos.filter((u) => (u.block_time ?? 0) > now - week).length;
    return {
      kind: "registry_stats",
      totalAgents: utxos.length,
      registeredLast7d: lastWeek,
      policy: "be1a0a29…2c01",
      note: "agents = UTxOs at the registry script address with inline CIP-68-style datums",
      source: "Koios (Vector mainnet)",
    };
  },
};

export const VIRTUAL_AGENTS: VirtualAgent[] = [NewsAgent, PriceAgent, MarketAgent, VectorChainAgent, StakingAgent, RegistryAgent];
