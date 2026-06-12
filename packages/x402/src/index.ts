import { z } from "zod";
import { ADDRESSES, verifyTransferAuthorization, type SignedAuthorization } from "@apex/chain-base";

export * from "./v2.js";

/**
 * x402 helpers (SPEC §5.3): HTTP 402 challenge, X-PAYMENT header verify, facilitator settle.
 * Challenge shape and EIP-3009 payload format follow the spec verbatim.
 */

export interface X402ChallengeOptions {
  maxAmountRequired: string; // USDC base units (6 decimals), decimal string
  resource: string;
  payTo: `0x${string}`;
  maxTimeoutSeconds?: number;
}

export function buildChallenge(opts: X402ChallengeOptions) {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact" as const,
        network: "base" as const,
        maxAmountRequired: opts.maxAmountRequired,
        resource: opts.resource,
        payTo: opts.payTo,
        asset: ADDRESSES.USDC,
        maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 60,
      },
    ],
  };
}
export type X402Challenge = ReturnType<typeof buildChallenge>;

/** X-PAYMENT header payload — base64(JSON). */
export const PaymentHeaderSchema = z.object({
  x402Version: z.literal(1),
  scheme: z.literal("exact"),
  network: z.literal("base"),
  payload: z.object({
    authorization: z.object({
      from: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      value: z.string().regex(/^\d+$/),
      validAfter: z.string().regex(/^\d+$/),
      validBefore: z.string().regex(/^\d+$/),
      nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    }),
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  }),
});
export type PaymentHeader = z.infer<typeof PaymentHeaderSchema>;

export function encodePaymentHeader(payment: PaymentHeader): string {
  return Buffer.from(JSON.stringify(payment), "utf8").toString("base64");
}

export function decodePaymentHeader(header: string): PaymentHeader {
  const json = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  return PaymentHeaderSchema.parse(json);
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
  signed?: SignedAuthorization;
}

/** Verify the X-PAYMENT header: shape, EIP-3009 signature, amount and recipient. */
export async function verifyPaymentHeader(
  header: string,
  expect: { payTo: `0x${string}`; maxAmountRequired: string },
  nowSec?: number,
): Promise<VerifyResult> {
  let payment: PaymentHeader;
  try {
    payment = decodePaymentHeader(header);
  } catch (err) {
    return { valid: false, reason: `malformed_header: ${(err as Error).message.slice(0, 120)}` };
  }
  const auth = payment.payload.authorization;
  if (auth.to.toLowerCase() !== expect.payTo.toLowerCase()) return { valid: false, reason: "wrong_recipient" };
  if (BigInt(auth.value) > BigInt(expect.maxAmountRequired)) return { valid: false, reason: "over_max_amount" };
  const signed: SignedAuthorization = {
    authorization: { ...auth, from: auth.from as `0x${string}`, to: auth.to as `0x${string}`, nonce: auth.nonce as `0x${string}` },
    signature: payment.payload.signature as `0x${string}`,
  };
  const sig = await verifyTransferAuthorization(signed, nowSec);
  if (!sig.valid) return { valid: false, reason: sig.reason };
  return { valid: true, signed };
}

export interface SettleResult {
  success: boolean;
  txHash?: string;
  error?: string;
}

/** Settle through the facilitator (SPEC §5.3, default Coinbase/x402.org). */
export async function settleWithFacilitator(
  facilitatorUrl: string,
  payment: PaymentHeader,
  fetchImpl: typeof fetch = fetch,
): Promise<SettleResult> {
  const res = await fetchImpl(`${facilitatorUrl.replace(/\/$/, "")}/settle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payment),
  });
  if (!res.ok) return { success: false, error: `facilitator HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
  const body = (await res.json()) as { success?: boolean; txHash?: string; transaction?: string; error?: string };
  return { success: body.success ?? false, txHash: body.txHash ?? body.transaction, error: body.error };
}
