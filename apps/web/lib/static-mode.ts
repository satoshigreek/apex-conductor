import { createPublicClient, http, parseUnits } from "viem";
import type { AgentView, RefuelQuoteResult } from "./api";

/**
 * Static / GitHub Pages mode — no conductor or refuel services behind the page.
 * Everything that CAN run in the browser does:
 *  - agent catalog: live Koios fetch (CORS is open on the public tier) + bundled snapshot fallback
 *  - refuel quote: Slipstream quoter via public Base RPC (read-only)
 * Orchestration (intents/payments/anchors) needs a conductor node — surfaced as a friendly error.
 */
export function isStaticMode(): boolean {
  if (typeof window === "undefined") return process.env.NEXT_PUBLIC_STATIC === "1";
  return window.location.hostname.endsWith("github.io") || process.env.NEXT_PUBLIC_STATIC === "1";
}

export const STATIC_MODE_HINT =
  "This is the static showcase (GitHub Pages) — orchestration needs a conductor node. Paste a node URL below (e.g. a cloudflared tunnel to your local conductor), or clone github.com/satoshigreek/apex-conductor and run one.";

const NODE_URL_KEY = "apex-node-url";

/** user-supplied conductor node (tunnel or hosted) the static GUI talks to directly;
 *  shareable links can pre-connect via ?node=https://… */
export function getNodeUrl(): string | null {
  if (typeof window === "undefined") return null;
  const fromQuery = new URLSearchParams(window.location.search).get("node");
  if (fromQuery && /^https?:\/\//.test(fromQuery)) {
    window.localStorage.setItem(NODE_URL_KEY, fromQuery.replace(/\/$/, ""));
  }
  const url = window.localStorage.getItem(NODE_URL_KEY);
  return url && /^https?:\/\//.test(url) ? url.replace(/\/$/, "") : null;
}

export function setNodeUrl(url: string | null): void {
  if (typeof window === "undefined") return;
  if (url && /^https?:\/\//.test(url)) window.localStorage.setItem(NODE_URL_KEY, url.replace(/\/$/, ""));
  else window.localStorage.removeItem(NODE_URL_KEY);
}

// ---------- live registry from the browser ----------

const KOIOS = "https://koios.vector.apexfusion.org/api/v1";
const REGISTRY_ADDR = "addr1wxlp5z3fztdpsp6ha57dvx6khw82kqvgcxwu8s8rjykjcqghprf42";
const REGISTRY_POLICY = "be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01";

const utf8 = new TextDecoder();

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function hexToText(hex: string): string {
  const text = utf8.decode(hexToBytes(hex));
  const printable = [...text].filter((c) => c >= " " && c <= "~").length;
  return printable / Math.max(text.length, 1) > 0.85 ? text : `0x${hex}`;
}

interface PlutusNode {
  bytes?: string;
  int?: number | string;
  list?: PlutusNode[];
  fields?: PlutusNode[];
  constructor?: number;
}

/** Confirmed live shape (docs/datum-audit.md): Constr0[Constr0[ownerPkh], name, desc, caps[], framework, endpoint, ts] */
function decodeRegistryDatum(datum: PlutusNode | null): { name: string | null; capabilities: string[]; ownerPkh: string | null } {
  const out: { name: string | null; capabilities: string[]; ownerPkh: string | null } = {
    name: null,
    capabilities: [],
    ownerPkh: null,
  };
  const fields = datum?.fields;
  if (!fields || fields.length < 4) return out;
  const ownerHex = fields[0]?.fields?.[0]?.bytes;
  if (typeof ownerHex === "string") out.ownerPkh = ownerHex;
  if (typeof fields[1]?.bytes === "string") out.name = hexToText(fields[1].bytes);
  const caps = fields[3]?.list;
  if (Array.isArray(caps)) {
    out.capabilities = caps.map((c) => (typeof c.bytes === "string" ? hexToText(c.bytes) : "")).filter(Boolean);
  }
  return out;
}

export async function fetchCatalogStatic(capability?: string): Promise<AgentView[]> {
  let agents: AgentView[];
  try {
    const res = await fetch(`${KOIOS}/address_utxos`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ _addresses: [REGISTRY_ADDR], _extended: true }),
    });
    if (!res.ok) throw new Error(`koios ${res.status}`);
    const utxos = (await res.json()) as Array<{
      tx_hash: string;
      tx_index: number;
      inline_datum?: { value?: PlutusNode } | null;
      asset_list?: Array<{ policy_id: string; asset_name: string | null }> | null;
    }>;
    agents = utxos.map((utxo) => {
      const decoded = decodeRegistryDatum(utxo.inline_datum?.value ?? null);
      const asset = utxo.asset_list?.find((a) => a.policy_id === REGISTRY_POLICY);
      const agentId = asset ? `${asset.policy_id}.${asset.asset_name ?? ""}` : `utxo:${utxo.tx_hash}#${utxo.tx_index}`;
      return {
        agentId,
        name: decoded.name ?? agentId,
        capabilities: decoded.capabilities,
        endpoint: null,
        pricing: null,
        stakeAp3x: 0,
        reputation: { score: 0.5, tasks: 0, disputes: 0 },
        status: "active",
        routable: false,
        source: null,
      } satisfies AgentView;
    });
  } catch {
    // bundled snapshot fallback (taken at build time)
    const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/catalog-snapshot.json`);
    agents = ((await res.json()) as { agents: AgentView[] }).agents;
  }
  return capability ? agents.filter((a) => a.capabilities.includes(capability)) : agents;
}

// ---------- live refuel quote from the browser ----------

const SLIPSTREAM_QUOTER = "0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0" as const;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const BAP3X = "0x9208d82f121806a34a39bb90733b4c5c54f3993e" as const;
const QUOTER_ABI = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "view",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "tickSpacing", type: "int24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const RPCS = ["https://base-rpc.publicnode.com", "https://mainnet.base.org"];

export async function quoteRefuelStatic(usdcAmount: number, maxSlippageBps = 100): Promise<RefuelQuoteResult> {
  let lastError: Error | null = null;
  for (const rpc of RPCS) {
    try {
      const client = createPublicClient({ transport: http(rpc) });
      const [out] = (await client.readContract({
        address: SLIPSTREAM_QUOTER,
        abi: QUOTER_ABI,
        functionName: "quoteExactInputSingle",
        args: [
          {
            tokenIn: USDC,
            tokenOut: BAP3X,
            amountIn: parseUnits(String(usdcAmount), 6),
            tickSpacing: 100,
            sqrtPriceLimitX96: 0n,
          },
        ],
      })) as readonly [bigint, bigint, number, bigint];
      const bap3xOut = Number(out) / 1e18;
      const minBap3xOut = (Number(out) * (10_000 - maxSlippageBps)) / 10_000 / 1e18;
      return {
        live: false,
        quote: { usdcIn: usdcAmount, bap3xOut, minBap3xOut, slippageBps: maxSlippageBps },
        swapTx: null,
        bridge: null,
        creditedAp3x: null,
        gasBalanceAp3x: null,
      };
    } catch (err) {
      lastError = err as Error;
    }
  }
  throw new Error(`quote failed on all RPCs: ${lastError?.message.slice(0, 120)}`);
}
