import { z } from "zod";
import { ADDRESSES, BASE_CHAIN_ID } from "@apex/chain-base";
import type { PaymentHeader } from "./index.js";

/**
 * x402 **version 2** adapter (resolves BLOCKER-6).
 * Wire format confirmed live against https://x402.org/facilitator on 2026-06-12:
 * a correctly-shaped, correctly-signed request returns
 * {isValid:false, invalidReason:"invalid_exact_evm_transaction_simulation_failed", payer:<recovered>}
 * for an unfunded payer — i.e. envelope + signature recovery accepted, only the
 * on-chain simulation gate remained.
 *
 * v2 differences from the SPEC §5.3 v1 shape:
 * - requirements: {scheme, network:"eip155:<id>", asset, amount, payTo, maxTimeoutSeconds, extra}
 *   (`amount`, not `maxAmountRequired`; CAIP-2 network; EIP-712 domain hints in `extra`)
 * - payload embeds the chosen requirement as `accepted` and the resource as an object
 * - facilitator endpoints: POST /verify and /settle with {paymentPayload, paymentRequirements}
 */
export const PaymentRequirementsV2Schema = z.object({
  scheme: z.literal("exact"),
  network: z.string().regex(/^eip155:\d+$/),
  asset: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  amount: z.string().regex(/^\d+$/),
  payTo: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z.record(z.unknown()),
});
export type PaymentRequirementsV2 = z.infer<typeof PaymentRequirementsV2Schema>;

export interface ResourceInfoV2 {
  url: string;
  description?: string;
  mimeType?: string;
}

export interface PaymentPayloadV2 {
  x402Version: 2;
  resource?: ResourceInfoV2;
  accepted: PaymentRequirementsV2;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

/** PaymentRequired body for the HTTP 402 response (v2). */
export interface PaymentRequiredV2 {
  x402Version: 2;
  error?: string;
  resource: ResourceInfoV2;
  accepts: PaymentRequirementsV2[];
  extensions?: Record<string, unknown>;
}

export interface ChallengeV2Options {
  amount: string; // USDC base units
  resourceUrl: string;
  description?: string;
  payTo: `0x${string}`;
  maxTimeoutSeconds?: number;
  /** defaults to Base mainnet USDC */
  network?: string;
  asset?: string;
  /** EIP-712 domain hints; Base mainnet USDC = {name:"USD Coin", version:"2"} */
  extra?: Record<string, unknown>;
}

export function buildRequirementsV2(opts: ChallengeV2Options): PaymentRequirementsV2 {
  return {
    scheme: "exact",
    network: opts.network ?? `eip155:${BASE_CHAIN_ID}`,
    asset: opts.asset ?? ADDRESSES.USDC,
    amount: opts.amount,
    payTo: opts.payTo,
    maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 60,
    extra: opts.extra ?? { name: "USD Coin", version: "2" },
  };
}

export function buildChallengeV2(opts: ChallengeV2Options): PaymentRequiredV2 {
  return {
    x402Version: 2,
    resource: { url: opts.resourceUrl, description: opts.description, mimeType: "application/json" },
    accepts: [buildRequirementsV2(opts)],
  };
}

/** Upgrade a SPEC-v1 X-PAYMENT payload (EIP-3009 authorization+signature) to a v2 payload. */
export function v1HeaderToV2Payload(
  v1: PaymentHeader,
  accepted: PaymentRequirementsV2,
  resource?: ResourceInfoV2,
): PaymentPayloadV2 {
  return {
    x402Version: 2,
    resource,
    accepted,
    payload: { authorization: v1.payload.authorization, signature: v1.payload.signature },
  };
}

export interface VerifyResponseV2 {
  isValid: boolean;
  invalidReason?: string;
  invalidMessage?: string;
  payer?: string;
}

export interface SettleResponseV2 {
  success: boolean;
  errorReason?: string;
  transaction?: string;
  txHash?: string;
  network?: string;
  payer?: string;
}

async function facilitatorPost<T>(
  facilitatorUrl: string,
  path: "verify" | "settle",
  paymentPayload: PaymentPayloadV2,
  paymentRequirements: PaymentRequirementsV2,
  fetchImpl: typeof fetch,
): Promise<T> {
  const res = await fetchImpl(`${facilitatorUrl.replace(/\/$/, "")}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paymentPayload, paymentRequirements }),
  });
  if (!res.ok) throw new Error(`facilitator /${path} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

export function verifyWithFacilitatorV2(
  facilitatorUrl: string,
  paymentPayload: PaymentPayloadV2,
  paymentRequirements: PaymentRequirementsV2,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResponseV2> {
  return facilitatorPost<VerifyResponseV2>(facilitatorUrl, "verify", paymentPayload, paymentRequirements, fetchImpl);
}

export async function settleWithFacilitatorV2(
  facilitatorUrl: string,
  paymentPayload: PaymentPayloadV2,
  paymentRequirements: PaymentRequirementsV2,
  fetchImpl: typeof fetch = fetch,
): Promise<SettleResponseV2> {
  const out = await facilitatorPost<SettleResponseV2>(facilitatorUrl, "settle", paymentPayload, paymentRequirements, fetchImpl);
  return { ...out, txHash: out.txHash ?? out.transaction };
}
