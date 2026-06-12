import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { signTransferAuthorization } from "@apex/chain-base";
import { encodePaymentHeader, type PaymentHeader } from "@apex/x402";
import { HandoffAdapter, createBridgeAdapter } from "./bridges.js";
import { MemoryGasLedger } from "./gasledger.js";
import { executeRefuel } from "./refuel.js";
import { buildRefuelServer } from "./server.js";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const account = privateKeyToAccount(PK);
const PAY_TO = "0x1111111111111111111111111111111111111111" as const;

/** publicClient stub: slipstream quoter returns 2:1 bAP3X per USDC (18 vs 6 decimals) */
function stubPublicClient(): PublicClient {
  return {
    readContract: vi.fn(async (args: { functionName: string; args: readonly unknown[] }) => {
      if (args.functionName === "quoteExactInputSingle") {
        const params = args.args[0] as { amountIn: bigint };
        return [params.amountIn * 2n * 10n ** 12n, 0n, 0, 0n];
      }
      throw new Error(`unexpected readContract ${args.functionName}`);
    }),
  } as unknown as PublicClient;
}

describe("executeRefuel (dry-run default — REFUEL_LIVE=false)", () => {
  it("quotes without any on-chain writes", async () => {
    const ledger = new MemoryGasLedger();
    const result = await executeRefuel(
      {
        publicClient: stubPublicClient(),
        walletClient: null,
        account: null,
        bridge: new HandoffAdapter(),
        ledger,
        live: false,
      },
      { usdcAmount: 5, vectorAddress: "vector_addr1xyz", mode: "swap_and_bridge", maxSlippageBps: 100 },
    );
    expect(result.live).toBe(false);
    expect(result.quote.bap3xOut).toBeCloseTo(10);
    expect(result.quote.minBap3xOut).toBeCloseTo(9.9);
    expect(result.swapTx).toBeNull();
    expect(await ledger.balance("vector_addr1xyz")).toBe(0);
  });
});

describe("bridge adapters (§5.4)", () => {
  it("handoff returns a deep-link and pending_manual", async () => {
    const adapter = new HandoffAdapter();
    const { id, status } = await adapter.bridge({ amountBap3x: "1000", fromAddress: "0xabc", toVectorAddress: "vec1" });
    expect(status.state).toBe("pending_manual");
    expect(status.deepLink).toContain("skylinebridge.tech");
    expect((await adapter.status(id)).state).toBe("pending_manual");
    adapter.confirm(id);
    expect((await adapter.status(id)).state).toBe("confirmed");
  });

  it("api/oft modes surface their blockers explicitly", async () => {
    await expect(createBridgeAdapter("api", "https://api.skyline.example").quote("1")).rejects.toThrow(/blocker-1/);
    await expect(createBridgeAdapter("oft").quote("1")).rejects.toThrow(/blocker-4/);
    expect(() => createBridgeAdapter("api", "")).toThrow(/SKYLINE_API/);
  });
});

describe("gas ledger", () => {
  it("credit/debit/history with insufficient-balance guard", async () => {
    const ledger = new MemoryGasLedger();
    expect(await ledger.credit("v1", 10, "x402", { tx: "t" })).toBe(10);
    expect(await ledger.debit("v1", 4, { reason: "task gas" })).toBe(6);
    await expect(ledger.debit("v1", 100, {})).rejects.toThrow(/insufficient/);
    expect((await ledger.history("v1")).map((e) => e.delta)).toEqual([10, -4]);
  });
});

describe("x402 topup endpoint (§5.3 server)", () => {
  function makeApp(fetchImpl: typeof fetch, protocol: "v1" | "v2" = "v1") {
    return buildRefuelServer({
      refuel: {
        publicClient: stubPublicClient(),
        walletClient: null,
        account: null,
        bridge: new HandoffAdapter(),
        ledger: new MemoryGasLedger(),
        live: false,
      },
      payTo: PAY_TO,
      facilitatorUrl: "https://facilitator.example",
      protocol,
      usdcPerAp3x: 0.01,
      maxTopupUsdc: "100000000",
      fetchImpl,
    });
  }

  async function makeHeader(nonceByte = "ee"): Promise<string> {
    const signed = await signTransferAuthorization(account, {
      from: account.address,
      to: PAY_TO,
      value: "5000000",
      validAfter: "0",
      validBefore: "9999999999",
      nonce: `0x${nonceByte.repeat(32)}` as `0x${string}`,
    });
    const payment: PaymentHeader = {
      x402Version: 1,
      scheme: "exact",
      network: "base",
      payload: { authorization: signed.authorization, signature: signed.signature },
    };
    return encodePaymentHeader(payment);
  }

  it("returns a 402 challenge without X-PAYMENT, settles with it, blocks nonce replay", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: true, txHash: "0xsettle" }), { status: 200 })) as unknown as typeof fetch;
    const app = makeApp(fetchImpl);

    const challenge = await app.inject({ method: "POST", url: "/v1/gas/topup", payload: { vectorAddress: "vector_addr1" } });
    expect(challenge.statusCode).toBe(402);
    expect(challenge.json()).toMatchObject({ x402Version: 1, accepts: [{ scheme: "exact", network: "base", payTo: PAY_TO }] });

    const header = await makeHeader();
    const paid = await app.inject({
      method: "POST",
      url: "/v1/gas/topup",
      headers: { "x-payment": header },
      payload: { vectorAddress: "vector_addr1" },
    });
    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toMatchObject({ ok: true, settleTx: "0xsettle", creditedAp3x: 500 }); // 5 USDC / 0.01

    const replay = await app.inject({
      method: "POST",
      url: "/v1/gas/topup",
      headers: { "x-payment": header },
      payload: { vectorAddress: "vector_addr1" },
    });
    expect(replay.statusCode).toBe(409);
  });

  it("v2 (BLOCKER-6): challenge is PaymentRequired shape; settle sends the v2 envelope", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://facilitator.example/settle");
      const body = JSON.parse(String(init?.body));
      // live-confirmed v2 envelope: {paymentPayload:{x402Version:2, accepted, payload}, paymentRequirements}
      expect(body.paymentPayload.x402Version).toBe(2);
      expect(body.paymentPayload.accepted).toEqual(body.paymentRequirements);
      expect(body.paymentRequirements).toMatchObject({
        scheme: "exact",
        network: "eip155:8453",
        amount: "5000000",
        payTo: PAY_TO,
        extra: { name: "USD Coin", version: "2" },
      });
      expect(body.paymentPayload.payload.signature).toMatch(/^0x/);
      return new Response(JSON.stringify({ success: true, transaction: "0xv2settle" }), { status: 200 });
    }) as unknown as typeof fetch;
    const app = makeApp(fetchImpl, "v2");

    const challenge = await app.inject({ method: "POST", url: "/v1/gas/topup", payload: { vectorAddress: "vector_addr1" } });
    expect(challenge.statusCode).toBe(402);
    expect(challenge.json()).toMatchObject({
      x402Version: 2,
      resource: { url: "/v1/gas/topup" },
      accepts: [{ scheme: "exact", network: "eip155:8453", payTo: PAY_TO }],
    });

    const paid = await app.inject({
      method: "POST",
      url: "/v1/gas/topup",
      headers: { "x-payment": await makeHeader("cc") },
      payload: { vectorAddress: "vector_addr1" },
    });
    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toMatchObject({ ok: true, settleTx: "0xv2settle", creditedAp3x: 500 });
  });

  it("rejects invalid signatures with 402", async () => {
    const app = makeApp(vi.fn() as unknown as typeof fetch);
    const header = await makeHeader("dd");
    const payment = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as PaymentHeader;
    payment.payload.authorization.value = "6000000"; // tamper after signing → signer mismatch
    const tampered = encodePaymentHeader(payment);
    const res = await app.inject({
      method: "POST",
      url: "/v1/gas/topup",
      headers: { "x-payment": tampered },
      payload: { vectorAddress: "vector_addr1" },
    });
    expect(res.statusCode).toBe(402);
  });
});
