/** SPEC §1.1/§1.2 — raw CBOR tx submission. */
export interface TxSubmitClientOptions {
  url: string;
  fetchImpl?: typeof fetch;
}

export class TxSubmitClient {
  constructor(private opts: TxSubmitClientOptions) {}

  async submit(cborHex: string): Promise<{ txHash: string }> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const res = await fetchImpl(this.opts.url, {
      method: "POST",
      headers: { "content-type": "application/cbor" },
      body: Buffer.from(cborHex, "hex"),
    });
    if (!res.ok) throw new Error(`tx submit failed: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.text()).trim().replace(/^"|"$/g, "");
    return { txHash: body };
  }
}
