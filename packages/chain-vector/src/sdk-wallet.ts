import type { AnchorRequest, PaymentRequest, VectorWallet } from "./wallet.js";

/**
 * SPEC §1.5 — all Vector tx construction via @apexfusion/agent-sdk (Lucid Evolution
 * + Ogmios provider). Loaded dynamically so the WASM stack only initializes when a
 * real wallet is configured (tests/dev use MockVectorWallet).
 *
 * Native-unit note: the SDK keeps Cardano naming — `ada`/`lovelace` — which on Vector
 * denominate AP3X (6 decimals). amountAp3x maps to the `ada` param 1:1.
 */
export interface SdkWalletConfig {
  mnemonic: string;
  ogmiosUrl: string;
  submitUrl: string;
  koiosUrl: string;
  /** SDK safety-layer caps (lovelace): default 100 AP3X/tx, 500 AP3X/day */
  spendLimitPerTx?: number;
  spendLimitDaily?: number;
  auditLogPath?: string;
}

interface VectorAgentLike {
  getAddress(): Promise<string>;
  send(params: { to: string; ada?: number; lovelace?: number; metadata?: Record<number, unknown> }): Promise<{ txHash: string }>;
  dryRun(params: { to: string; ada?: number; lovelace?: number }): Promise<{ ok?: boolean; success?: boolean; feeLovelace?: number; fee?: number; error?: string }>;
  close(): Promise<void>;
}

/** Conductor metadata label for anchors (SDK uses 674 for agent messages; anchors share it). */
const ANCHOR_METADATA_LABEL = 674;

export class SdkVectorWallet implements VectorWallet {
  private constructor(private agent: VectorAgentLike) {}

  static async create(config: SdkWalletConfig): Promise<SdkVectorWallet> {
    const sdk = (await import("@apexfusion/agent-sdk")) as unknown as {
      VectorAgent: new (cfg: Record<string, unknown>) => VectorAgentLike;
    };
    const agent = new sdk.VectorAgent({
      mnemonic: config.mnemonic,
      ogmiosUrl: config.ogmiosUrl,
      submitUrl: config.submitUrl,
      koiosUrl: config.koiosUrl,
      spendLimitPerTx: config.spendLimitPerTx,
      spendLimitDaily: config.spendLimitDaily,
      auditLogPath: config.auditLogPath,
    });
    return new SdkVectorWallet(agent);
  }

  address(): Promise<string> {
    return this.agent.getAddress();
  }

  async payAp3x(req: PaymentRequest): Promise<{ txHash: string }> {
    const { txHash } = await this.agent.send({
      to: req.toAddress,
      ada: req.amountAp3x,
      metadata: req.metadata ? { [ANCHOR_METADATA_LABEL]: { msg: ["conductor-payment"], ...req.metadata } } : undefined,
    });
    return { txHash };
  }

  async anchor(req: AnchorRequest): Promise<{ txHash: string }> {
    const self = await this.agent.getAddress();
    // min-UTxO self-send carrying the audit summary (SPEC §5.2 anchor)
    const { txHash } = await this.agent.send({
      to: self,
      ada: 1,
      metadata: {
        [ANCHOR_METADATA_LABEL]: {
          msg: ["conductor-anchor"],
          taskId: req.taskId,
          planHash: req.planHash,
          resultHash: req.resultHash,
          totalFees: req.totalFees,
          agents: req.agents.slice(0, 20),
        },
      },
    });
    return { txHash };
  }

  async dryRunPay(req: PaymentRequest): Promise<{ ok: boolean; estimatedFeeAp3x: number; reason?: string }> {
    try {
      const result = await this.agent.dryRun({ to: req.toAddress, ada: req.amountAp3x });
      const ok = result.ok ?? result.success ?? false;
      const feeLovelace = result.feeLovelace ?? result.fee ?? 0;
      return { ok, estimatedFeeAp3x: feeLovelace / 1_000_000, reason: result.error };
    } catch (err) {
      return { ok: false, estimatedFeeAp3x: 0, reason: (err as Error).message };
    }
  }

  async close(): Promise<void> {
    await this.agent.close();
  }
}
