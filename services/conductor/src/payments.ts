import { checkSpend, protocolFee, type SpendPolicy } from "@apex/core";
import type { VectorWallet } from "@apex/chain-vector";
import type { TaskStore } from "./taskstore.js";

/**
 * SPEC §5.2 Payments v1 (M2, escrowless): hot wallet pays the agent fee AFTER verification.
 * 2.5% protocol fee accrues to PROTOCOL_TREASURY_ADDR. Hard caps enforced here, in code.
 * Payments v2 (M4) replaces this with the Aiken escrow validator.
 */
export interface PaymentEngineOptions {
  wallet: VectorWallet;
  store: TaskStore;
  policy: SpendPolicy;
  treasuryAddr: string | null;
  log?: (msg: string) => void;
}

export type PayOutcome =
  | { ok: true; txHash: string; feeAp3x: number; protocolFeeAp3x: number }
  | { ok: false; reason: string };

export class PaymentEngine {
  private sessionSpent = 0;

  constructor(private opts: PaymentEngineOptions) {}

  async payAgent(input: {
    taskId: string;
    stepId: string;
    toAddress: string;
    amountAp3x: number;
    taskSpentAp3x: number;
  }): Promise<PayOutcome> {
    const { wallet, store, policy, treasuryAddr } = this.opts;
    const daySpent = await store.spentToday();
    const allowed = checkSpend(
      policy,
      { task: input.taskSpentAp3x, session: this.sessionSpent, day: daySpent },
      input.amountAp3x,
    );
    if (!allowed.ok) {
      await store.appendEvent("payments", "spend_denied", { ...input, reason: allowed.reason, cap: allowed.cap });
      return { ok: false, reason: `${allowed.reason} (cap ${allowed.cap})` };
    }

    // safety invariant 4: dry-run precedes every value move
    const dry = await wallet.dryRunPay({ toAddress: input.toAddress, amountAp3x: input.amountAp3x });
    if (!dry.ok) {
      await store.appendEvent("payments", "dry_run_failed", { ...input, reason: dry.reason });
      return { ok: false, reason: `dry_run_failed: ${dry.reason ?? "unknown"}` };
    }

    const { txHash } = await wallet.payAp3x({
      toAddress: input.toAddress,
      amountAp3x: input.amountAp3x,
      metadata: { taskId: input.taskId, stepId: input.stepId },
    });
    this.sessionSpent += input.amountAp3x;
    await store.recordPayment({
      taskId: input.taskId,
      stepId: input.stepId,
      kind: "release",
      amount: input.amountAp3x,
      asset: "AP3X",
      txHash,
      status: "confirmed",
    });

    const fee = protocolFee(policy, input.amountAp3x);
    let protocolFeeAp3x = 0;
    if (fee > 0 && treasuryAddr) {
      const feeDry = await wallet.dryRunPay({ toAddress: treasuryAddr, amountAp3x: fee });
      if (feeDry.ok) {
        const feeTx = await wallet.payAp3x({
          toAddress: treasuryAddr,
          amountAp3x: fee,
          metadata: { taskId: input.taskId, kind: "protocol_fee" },
        });
        protocolFeeAp3x = fee;
        await store.recordPayment({
          taskId: input.taskId,
          stepId: input.stepId,
          kind: "protocol_fee",
          amount: fee,
          asset: "AP3X",
          txHash: feeTx.txHash,
          status: "confirmed",
        });
      } else {
        this.opts.log?.(`protocol fee dry-run failed for task ${input.taskId}: ${feeDry.reason}`);
      }
    }
    return { ok: true, txHash, feeAp3x: input.amountAp3x, protocolFeeAp3x };
  }
}
