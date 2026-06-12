import { z } from "zod";

/**
 * Koios REST client (SPEC §1.1/§1.2). Endpoints used: /tip, /address_utxos, /epoch_info, /totals.
 * Public tier is CORS-restricted — this client is for BACKEND use only.
 */
export interface KoiosClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const TipSchema = z.array(
  z.object({
    hash: z.string(),
    epoch_no: z.number(),
    abs_slot: z.number(),
    epoch_slot: z.number(),
    block_no: z.number().nullable(),
    block_time: z.number(),
  }),
);
export type KoiosTip = z.infer<typeof TipSchema>[number];

const UtxoSchema = z.object({
  tx_hash: z.string(),
  tx_index: z.number(),
  address: z.string().optional(),
  value: z.string(),
  datum_hash: z.string().nullable().optional(),
  inline_datum: z
    .object({ bytes: z.string(), value: z.unknown() })
    .nullable()
    .optional(),
  asset_list: z
    .array(z.object({ policy_id: z.string(), asset_name: z.string().nullable(), fingerprint: z.string().optional(), quantity: z.string() }))
    .nullable()
    .optional(),
  block_time: z.number().optional(),
});
export type KoiosUtxo = z.infer<typeof UtxoSchema>;
const UtxoListSchema = z.array(UtxoSchema);

export class KoiosClient {
  private baseUrl: string;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;

  constructor(opts: KoiosClientOptions) {
    // accept both ".../api/v1" (mainnet style) and bare host (testnet style)
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    if (!/\/api\/v\d+$/.test(this.baseUrl)) this.baseUrl += "/api/v1";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  private async request<T>(path: string, init: RequestInit, schema: z.ZodType<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { accept: "application/json", "content-type": "application/json", ...init.headers },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`koios ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return schema.parse(await res.json());
    } finally {
      clearTimeout(timer);
    }
  }

  async tip(): Promise<KoiosTip> {
    const tips = await this.request("/tip", { method: "GET" }, TipSchema);
    if (!tips[0]) throw new Error("koios /tip returned empty array");
    return tips[0];
  }

  /** SPEC §1.3 — registry agents are UTXOs at the script address; _extended=true returns inline datums. */
  async addressUtxos(address: string, extended = true): Promise<KoiosUtxo[]> {
    return this.request(
      "/address_utxos",
      { method: "POST", body: JSON.stringify({ _addresses: [address], _extended: extended }) },
      UtxoListSchema,
    );
  }

  async epochInfo(): Promise<unknown> {
    return this.request("/epoch_info", { method: "GET" }, z.unknown());
  }

  async totals(): Promise<unknown> {
    return this.request("/totals", { method: "GET" }, z.unknown());
  }
}
