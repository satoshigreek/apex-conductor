import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { signTransferAuthorization, ADDRESSES } from "@apex/chain-base";
import {
  buildChallenge,
  decodePaymentHeader,
  encodePaymentHeader,
  settleWithFacilitator,
  verifyPaymentHeader,
  type PaymentHeader,
} from "./index.js";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const account = privateKeyToAccount(PK);
const PAY_TO = "0x1111111111111111111111111111111111111111" as const;

async function makePayment(value = "5000000"): Promise<PaymentHeader> {
  const signed = await signTransferAuthorization(account, {
    from: account.address,
    to: PAY_TO,
    value,
    validAfter: "0",
    validBefore: "9999999999",
    nonce: `0x${"cd".repeat(32)}` as `0x${string}`,
  });
  return {
    x402Version: 1,
    scheme: "exact",
    network: "base",
    payload: { authorization: signed.authorization, signature: signed.signature },
  };
}

describe("x402 challenge", () => {
  it("matches the SPEC §5.3 shape", () => {
    const c = buildChallenge({ maxAmountRequired: "1000000", resource: "/v1/gas/topup", payTo: PAY_TO });
    expect(c).toEqual({
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: "base",
          maxAmountRequired: "1000000",
          resource: "/v1/gas/topup",
          payTo: PAY_TO,
          asset: ADDRESSES.USDC,
          maxTimeoutSeconds: 60,
        },
      ],
    });
  });
});

describe("X-PAYMENT verify", () => {
  it("encode → decode → verify happy path", async () => {
    const payment = await makePayment();
    const header = encodePaymentHeader(payment);
    expect(decodePaymentHeader(header)).toEqual(payment);
    const result = await verifyPaymentHeader(header, { payTo: PAY_TO, maxAmountRequired: "5000000" }, 1_000_000);
    expect(result.valid).toBe(true);
  });

  it("rejects wrong recipient, over-amount, malformed", async () => {
    const payment = await makePayment();
    const header = encodePaymentHeader(payment);
    expect(
      (await verifyPaymentHeader(header, { payTo: "0x2222222222222222222222222222222222222222", maxAmountRequired: "5000000" }, 1_000_000)).reason,
    ).toBe("wrong_recipient");
    expect((await verifyPaymentHeader(header, { payTo: PAY_TO, maxAmountRequired: "1000000" }, 1_000_000)).reason).toBe("over_max_amount");
    expect((await verifyPaymentHeader("not-base64-json", { payTo: PAY_TO, maxAmountRequired: "1" }, 1_000_000)).valid).toBe(false);
  });

  it("rejects tampered signature payloads", async () => {
    const payment = await makePayment();
    payment.payload.authorization.value = "9000000"; // tamper after signing
    const result = await verifyPaymentHeader(encodePaymentHeader(payment), { payTo: PAY_TO, maxAmountRequired: "9000000" }, 1_000_000);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("signer_mismatch");
  });
});

describe("facilitator settle", () => {
  it("402→retry→settle happy path against a mock facilitator", async () => {
    const payment = await makePayment();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://facilitator.example/settle");
      expect(JSON.parse(String(init?.body)).x402Version).toBe(1);
      return new Response(JSON.stringify({ success: true, txHash: "0xsettled" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await settleWithFacilitator("https://facilitator.example/", payment, fetchImpl);
    expect(result).toEqual({ success: true, txHash: "0xsettled", error: undefined });
  });

  it("surfaces facilitator errors", async () => {
    const payment = await makePayment();
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const result = await settleWithFacilitator("https://facilitator.example", payment, fetchImpl);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/HTTP 500/);
  });
});
