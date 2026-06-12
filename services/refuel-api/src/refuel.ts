import type { Account, Address, PublicClient, WalletClient } from "viem";
import { bap3xToDecimal, quoteUsdcToBap3x, swapUsdcToBap3x, usdcUnits } from "@apex/chain-base";
import type { BridgeAdapter } from "./bridges.js";
import type { GasLedger } from "./gasledger.js";

/**
 * SPEC §5.3 — POST /v1/refuel pipeline: Base swap (approve→swapExactTokensForTokens on
 * Aerodrome) → bridge adapter → credit gas_accounts.
 * REFUEL_LIVE=false (default): quote + simulate only; no on-chain writes.
 */
export interface RefuelDeps {
  publicClient: PublicClient;
  walletClient: WalletClient | null;
  account: Account | null;
  bridge: BridgeAdapter;
  ledger: GasLedger;
  live: boolean;
  log?: (msg: string) => void;
}

export interface RefuelRequest {
  usdcAmount: number;
  vectorAddress: string;
  mode: "swap_and_bridge" | "x402_stream";
  maxSlippageBps: number;
}

export interface RefuelResult {
  live: boolean;
  quote: {
    usdcIn: number;
    bap3xOut: number;
    minBap3xOut: number;
    slippageBps: number;
  };
  swapTx: string | null;
  bridge: { id: string; state: string; deepLink?: string } | null;
  creditedAp3x: number | null;
  gasBalanceAp3x: number | null;
}

export async function executeRefuel(deps: RefuelDeps, req: RefuelRequest): Promise<RefuelResult> {
  const amountIn = usdcUnits(req.usdcAmount);
  const quote = await quoteUsdcToBap3x(deps.publicClient, amountIn, req.maxSlippageBps);
  const result: RefuelResult = {
    live: deps.live,
    quote: {
      usdcIn: req.usdcAmount,
      bap3xOut: bap3xToDecimal(quote.amountOutBap3x),
      minBap3xOut: bap3xToDecimal(quote.minOutBap3x),
      slippageBps: req.maxSlippageBps,
    },
    swapTx: null,
    bridge: null,
    creditedAp3x: null,
    gasBalanceAp3x: null,
  };

  if (!deps.live) {
    deps.log?.(`refuel dry-run: ${req.usdcAmount} USDC → ~${result.quote.bap3xOut} bAP3X (REFUEL_LIVE=false)`);
    return result;
  }
  if (!deps.walletClient || !deps.account) throw new Error("REFUEL_LIVE=true requires BASE_HOT_WALLET_PK");

  const swap = await swapUsdcToBap3x(
    deps.publicClient,
    deps.walletClient,
    deps.account,
    quote,
    deps.account.address as Address,
  );
  result.swapTx = swap.swapTx;

  const bridged = await deps.bridge.bridge({
    amountBap3x: quote.minOutBap3x.toString(),
    fromAddress: deps.account.address,
    toVectorAddress: req.vectorAddress,
  });
  result.bridge = { id: bridged.id, state: bridged.status.state, deepLink: bridged.status.deepLink };

  // handoff mode: credit applies when the manual bridge confirms (operator console);
  // api/oft modes credit immediately on confirmed bridge submission
  if (bridged.status.state === "confirmed" || bridged.status.state === "submitted") {
    const credited = bap3xToDecimal(quote.minOutBap3x);
    result.creditedAp3x = credited;
    result.gasBalanceAp3x = await deps.ledger.credit(req.vectorAddress, credited, "refuel_swap", {
      swapTx: swap.swapTx,
      bridgeId: bridged.id,
    });
  }
  return result;
}
