import { describe, expect, it, vi } from "vitest";
import { KoiosClient } from "./koios.js";

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("KoiosClient", () => {
  it("appends /api/v1 to bare hosts and not to versioned URLs", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return jsonResponse([{ hash: "h", epoch_no: 1, abs_slot: 2, epoch_slot: 3, block_no: 4, block_time: 5 }]);
    }) as unknown as typeof fetch;

    await new KoiosClient({ baseUrl: "https://v2.koios.vector.testnet.apexfusion.org/", fetchImpl }).tip();
    await new KoiosClient({ baseUrl: "https://koios.vector.apexfusion.org/api/v1", fetchImpl }).tip();
    expect(calls[0]).toBe("https://v2.koios.vector.testnet.apexfusion.org/api/v1/tip");
    expect(calls[1]).toBe("https://koios.vector.apexfusion.org/api/v1/tip");
  });

  it("posts _extended for address_utxos and parses inline datums", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        _addresses: ["addr1wxlp5z3fztdpsp6ha57dvx6khw82kqvgcxwu8s8rjykjcqghprf42"],
        _extended: true,
      });
      return jsonResponse([
        { tx_hash: "t", tx_index: 0, value: "2000000", inline_datum: { bytes: "00", value: { int: 1 } }, asset_list: [] },
      ]);
    }) as unknown as typeof fetch;

    const utxos = await new KoiosClient({ baseUrl: "https://x.example", fetchImpl }).addressUtxos(
      "addr1wxlp5z3fztdpsp6ha57dvx6khw82kqvgcxwu8s8rjykjcqghprf42",
    );
    expect(utxos).toHaveLength(1);
    expect(utxos[0]!.inline_datum?.value).toEqual({ int: 1 });
  });

  it("throws useful errors on non-2xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
    await expect(new KoiosClient({ baseUrl: "https://x.example", fetchImpl }).tip()).rejects.toThrow(/HTTP 429/);
  });
});
