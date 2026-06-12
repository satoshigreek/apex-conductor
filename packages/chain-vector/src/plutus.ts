/**
 * Tolerant Plutus-data JSON decoder (Koios `inline_datum.value` shape).
 * Plutus data JSON: {constructor, fields} | {bytes} | {int} | {list} | {map}.
 * BLOCKER-3: exact registry field mapping is confirmed by scripts/audit-datums.ts (M1);
 * decodeAgentDatum below is deliberately defensive and returns whatever it can.
 */
export type PlutusJson =
  | { constructor: number; fields: PlutusJson[] }
  | { bytes: string }
  | { int: number | string }
  | { list: PlutusJson[] }
  | { map: Array<{ k: PlutusJson; v: PlutusJson }> };

export type Decoded = string | bigint | Decoded[] | { tag: number; values: Decoded[] } | Map<Decoded, Decoded> | null;

export function hexToUtf8(hex: string): string {
  const bytes = Buffer.from(hex, "hex");
  const text = bytes.toString("utf8");
  // heuristics: if it round-trips and is mostly printable, treat as text
  const printable = [...text].filter((c) => c >= " " && c <= "~").length;
  return printable / Math.max(text.length, 1) > 0.85 ? text : `0x${hex}`;
}

export function decodePlutus(value: unknown): Decoded {
  if (value === null || value === undefined) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.bytes === "string") return hexToUtf8(v.bytes);
  if (v.int !== undefined) return BigInt(v.int as number | string);
  if (Array.isArray(v.list)) return v.list.map(decodePlutus);
  if (Array.isArray(v.map)) {
    const m = new Map<Decoded, Decoded>();
    for (const entry of v.map as Array<{ k: unknown; v: unknown }>) m.set(decodePlutus(entry.k), decodePlutus(entry.v));
    return m;
  }
  if (typeof v.constructor === "number" && Array.isArray(v.fields)) {
    return { tag: v.constructor as number, values: (v.fields as unknown[]).map(decodePlutus) };
  }
  return null;
}

/** JSON-safe rendering for audits/logs (bigint→string, Map→object). */
export function decodedToJson(d: Decoded): unknown {
  if (d === null) return null;
  if (typeof d === "bigint") return d.toString();
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map(decodedToJson);
  if (d instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of d) obj[String(decodedToJson(k))] = decodedToJson(v);
    return obj;
  }
  return { tag: d.tag, values: d.values.map(decodedToJson) };
}

export interface RawAgentDatum {
  /** best-effort extraction; nulls where the datum doesn't carry the field (BLOCKER-3) */
  name: string | null;
  capabilities: string[];
  endpointUrl: string | null;
  endpointType: string | null;
  pricingAmount: number | null;
  pricingModel: string | null;
  stake: number | null;
  ownerPkh: string | null;
  decoded: unknown;
}

const isUrl = (s: string) => /^https?:\/\//.test(s) || /^wss?:\/\//.test(s);
// raw key hashes decode as non-printable bytes and come back 0x-prefixed from hexToUtf8
const looksLikePkh = (s: string) => /^(0x)?[0-9a-f]{56,64}$/i.test(s);
const stripHexPrefix = (s: string) => (s.startsWith("0x") ? s.slice(2) : s);

/**
 * Confirmed LIVE registry shape (docs/datum-audit.md, Vector mainnet epoch 290, 782 agents):
 *   Constr0 [ Constr0[ownerPkh·bytes], name·utf8, description·utf8,
 *             capabilities·list<utf8>, framework·utf8, endpoint·bytes (EMPTY on-chain → BLOCKER-3),
 *             registeredAt·ms ]
 * Positional decode below targets that shape first; map/heuristic passes cover variants.
 */
function decodePositionalRegistryShape(decoded: Decoded, out: RawAgentDatum): boolean {
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded) || decoded instanceof Map) return false;
  if (decoded.tag !== 0 || decoded.values.length < 4) return false;
  const v = decoded.values;
  const owner = v[0];
  if (owner === null || typeof owner !== "object" || Array.isArray(owner) || owner instanceof Map) return false;
  const pkh = owner.values[0];
  if (typeof pkh !== "string" || typeof v[1] !== "string" || !Array.isArray(v[3])) return false;

  out.ownerPkh = stripHexPrefix(pkh);
  out.name = v[1];
  out.capabilities = v[3].filter((x): x is string => typeof x === "string");
  // v[4] is the framework slot (e.g. "claude-code") — kept in the decoded tree, not an endpoint type
  if (typeof v[5] === "string" && isUrl(v[5])) out.endpointUrl = v[5]; // reserved slot, empty on-chain today
  return true;
}

/** Walk the decoded tree and pattern-match likely fields. Refined per docs/datum-audit.md. */
export function decodeAgentDatum(inlineDatumValue: unknown): RawAgentDatum {
  const decoded = decodePlutus(inlineDatumValue);
  const out: RawAgentDatum = {
    name: null,
    capabilities: [],
    endpointUrl: null,
    endpointType: null,
    pricingAmount: null,
    pricingModel: null,
    stake: null,
    ownerPkh: null,
    decoded: decodedToJson(decoded),
  };

  if (decodePositionalRegistryShape(decoded, out)) return out;

  const strings: string[] = [];
  const ints: bigint[] = [];
  const maps: Map<Decoded, Decoded>[] = [];
  const walk = (d: Decoded): void => {
    if (d === null) return;
    if (typeof d === "string") strings.push(d);
    else if (typeof d === "bigint") ints.push(d);
    else if (Array.isArray(d)) d.forEach(walk);
    else if (d instanceof Map) {
      maps.push(d);
      for (const [k, v] of d) {
        walk(k);
        walk(v);
      }
    } else d.values.forEach(walk);
  };
  walk(decoded);

  // explicit key/value maps win when present (CIP-68-style metadata)
  for (const m of maps) {
    for (const [k, v] of m) {
      if (typeof k !== "string") continue;
      const key = k.toLowerCase();
      if (typeof v === "string") {
        if (key === "name") out.name = v;
        if (key === "endpoint" || key === "url" || key === "endpoint_url") out.endpointUrl = v;
        if (key === "endpoint_type" || key === "protocol") out.endpointType = v;
        if (key === "owner" || key === "owner_pkh") out.ownerPkh = v.startsWith("0x") ? v.slice(2) : v;
        if (key === "pricing_model") out.pricingModel = v;
      }
      if (typeof v === "bigint") {
        if (key === "stake") out.stake = Number(v);
        if (key === "price" || key === "fee" || key === "amount") out.pricingAmount = Number(v);
      }
      if (Array.isArray(v) && (key === "capabilities" || key === "caps")) {
        out.capabilities = v.filter((x): x is string => typeof x === "string");
      }
    }
  }

  // positional fallbacks
  if (!out.endpointUrl) out.endpointUrl = strings.find(isUrl) ?? null;
  if (!out.ownerPkh) {
    const pkh = strings.find((s) => looksLikePkh(s) && !isUrl(s));
    out.ownerPkh = pkh ? stripHexPrefix(pkh) : null;
  }
  if (!out.name) {
    out.name = strings.find((s) => !isUrl(s) && !looksLikePkh(s) && !s.startsWith("0x") && s.length <= 64) ?? null;
  }
  return out;
}
