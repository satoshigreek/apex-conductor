/**
 * Vector wallet abstraction. SPEC §1.5: all tx construction goes through agent-sdk-ts
 * (Lucid Evolution). The SDK is wired in M2 behind this interface so the rest of the
 * system never imports Lucid directly.
 */
export interface PaymentRequest {
  toAddress: string;
  amountAp3x: number;
  metadata?: Record<string, unknown>;
}

export interface AnchorRequest {
  /** SPEC §5.2 anchor: {taskId, planHash, resultHash, totalFees, agents[]} */
  taskId: string;
  planHash: string;
  resultHash: string;
  totalFees: number;
  agents: string[];
}

export interface VectorWallet {
  address(): Promise<string>;
  payAp3x(req: PaymentRequest): Promise<{ txHash: string }>;
  anchor(req: AnchorRequest): Promise<{ txHash: string }>;
  /** dry-run MUST precede any value-moving call (safety invariant 4) */
  dryRunPay(req: PaymentRequest): Promise<{ ok: boolean; estimatedFeeAp3x: number; reason?: string }>;
}

/** In-memory wallet for tests and dev without keys; records what would have been sent. */
export class MockVectorWallet implements VectorWallet {
  public payments: PaymentRequest[] = [];
  public anchors: AnchorRequest[] = [];
  private counter = 0;

  constructor(private addr = "vector_test1mockwalletaddress") {}

  async address(): Promise<string> {
    return this.addr;
  }

  async payAp3x(req: PaymentRequest): Promise<{ txHash: string }> {
    this.payments.push(req);
    return { txHash: `mock_pay_${++this.counter}` };
  }

  async anchor(req: AnchorRequest): Promise<{ txHash: string }> {
    this.anchors.push(req);
    return { txHash: `mock_anchor_${++this.counter}` };
  }

  async dryRunPay(req: PaymentRequest): Promise<{ ok: boolean; estimatedFeeAp3x: number; reason?: string }> {
    if (req.amountAp3x <= 0) return { ok: false, estimatedFeeAp3x: 0, reason: "non_positive_amount" };
    return { ok: true, estimatedFeeAp3x: 0.2 };
  }
}

// TODO(M2): LucidVectorWallet implements VectorWallet via @apex-fusion/agent-sdk-ts
// (Lucid Evolution + Ogmios provider per SPEC §1.5). Kept out of M0/M1 so the scaffold
// builds without the SDK dependency resolved.
