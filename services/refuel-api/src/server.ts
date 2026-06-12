import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import {
  buildChallenge,
  buildChallengeV2,
  buildRequirementsV2,
  decodePaymentHeader,
  settleWithFacilitator,
  settleWithFacilitatorV2,
  v1HeaderToV2Payload,
  verifyPaymentHeader,
} from "@apex/x402";
import type { RefuelDeps, RefuelRequest } from "./refuel.js";
import { executeRefuel } from "./refuel.js";

/** SPEC §5.3 — /v1/refuel, /v1/gas/:addr, /v1/gas/topup (x402-protected). */
export interface RefuelServerDeps {
  refuel: RefuelDeps;
  payTo: `0x${string}` | null;
  facilitatorUrl: string;
  /**
   * Facilitator protocol. SPEC §5.3 fixes v1, but the live x402.org facilitator speaks
   * x402Version 2 (BLOCKER-6) — default v2; the inbound X-PAYMENT header stays v1 and is
   * upgraded via v1HeaderToV2Payload.
   */
  protocol?: "v1" | "v2";
  /** USDC base units per 1 AP3X of gas credit (pricing knob; ops-tunable) */
  usdcPerAp3x: number;
  maxTopupUsdc: string;
  fetchImpl?: typeof fetch;
}

const RefuelBody = z.object({
  usdcAmount: z.number().positive().max(100_000),
  vectorAddress: z.string().min(8),
  mode: z.enum(["swap_and_bridge", "x402_stream"]).default("swap_and_bridge"),
  maxSlippageBps: z.number().int().min(1).max(2000).default(100),
});

export function buildRefuelServer(deps: RefuelServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const usedNonces = new Set<string>();

  app.get("/health", async () => ({ ok: true, service: "refuel-api", live: deps.refuel.live, bridgeMode: deps.refuel.bridge.mode }));

  app.post("/v1/refuel", async (req, reply) => {
    const body = RefuelBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    try {
      const result = await executeRefuel(deps.refuel, body.data as RefuelRequest);
      return reply.code(200).send(result);
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.get("/v1/gas/:vectorAddress", async (req) => {
    const { vectorAddress } = req.params as { vectorAddress: string };
    return { vectorAddress, balanceAp3x: await deps.refuel.ledger.balance(vectorAddress) };
  });

  app.post("/v1/gas/topup", async (req, reply) => {
    if (!deps.payTo) return reply.code(503).send({ error: "REFUEL_PAYTO not configured" });
    const TopupBody = z.object({ vectorAddress: z.string().min(8) });
    const body = TopupBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });

    const protocol = deps.protocol ?? "v2";
    const header = req.headers["x-payment"];
    if (typeof header !== "string" || header.length === 0) {
      // 402 challenge — v1 shape per SPEC §5.3, v2 per the live facilitator (BLOCKER-6)
      if (protocol === "v1") {
        return reply.code(402).send(
          buildChallenge({ maxAmountRequired: deps.maxTopupUsdc, resource: "/v1/gas/topup", payTo: deps.payTo }),
        );
      }
      return reply.code(402).send(
        buildChallengeV2({
          amount: deps.maxTopupUsdc,
          resourceUrl: "/v1/gas/topup",
          description: "Vector gas top-up (AP3X credit)",
          payTo: deps.payTo,
        }),
      );
    }

    const verified = await verifyPaymentHeader(header, { payTo: deps.payTo, maxAmountRequired: deps.maxTopupUsdc });
    if (!verified.valid) return reply.code(402).send({ error: `payment rejected: ${verified.reason}` });

    const nonce = verified.signed!.authorization.nonce;
    if (usedNonces.has(nonce)) return reply.code(409).send({ error: "authorization nonce already used" });

    const payment = decodePaymentHeader(header);
    let settled: { success: boolean; txHash?: string; error?: string };
    if (protocol === "v1") {
      settled = await settleWithFacilitator(deps.facilitatorUrl, payment, deps.fetchImpl ?? fetch);
    } else {
      const requirements = buildRequirementsV2({
        amount: payment.payload.authorization.value,
        resourceUrl: "/v1/gas/topup",
        payTo: deps.payTo,
      });
      const out = await settleWithFacilitatorV2(
        deps.facilitatorUrl,
        v1HeaderToV2Payload(payment, requirements, { url: "/v1/gas/topup" }),
        requirements,
        deps.fetchImpl ?? fetch,
      );
      settled = { success: out.success, txHash: out.txHash, error: out.errorReason };
    }
    if (!settled.success) return reply.code(502).send({ error: `settlement failed: ${settled.error}` });
    usedNonces.add(nonce);

    // on settlement, enqueue a refuel job for the paid amount and credit gas (SPEC §5.3)
    const usdcPaid = Number(verified.signed!.authorization.value) / 1e6;
    const creditAp3x = usdcPaid / deps.usdcPerAp3x;
    const balance = await deps.refuel.ledger.credit(body.data.vectorAddress, creditAp3x, "x402", {
      settleTx: settled.txHash,
      usdcPaid,
    });
    return { ok: true, settleTx: settled.txHash, creditedAp3x: creditAp3x, balanceAp3x: balance };
  });

  return app;
}
