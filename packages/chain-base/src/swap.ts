import type { Account, Address, PublicClient, WalletClient } from "viem";
import { parseUnits } from "viem";
import {
  ADDRESSES,
  AERODROME_ROUTER_ABI,
  BAP3X_DECIMALS,
  ERC20_ABI,
  SLIPSTREAM,
  SLIPSTREAM_QUOTER_ABI,
  SLIPSTREAM_ROUTER_ABI,
  SWAP_ROUTE,
  USDC_DECIMALS,
} from "./constants.js";

export interface SwapQuote {
  amountInUsdc: bigint;
  amountOutBap3x: bigint;
  minOutBap3x: bigint;
  route: typeof SWAP_ROUTE;
  slippageBps: number;
}

export function usdcUnits(amount: number | string): bigint {
  return parseUnits(String(amount), USDC_DECIMALS);
}

export function bap3xToDecimal(amount: bigint): number {
  return Number(amount) / 10 ** BAP3X_DECIMALS;
}

/**
 * Quote USDC→bAP3X; minOut = quote × (1 − slippage). SPEC §5.3.
 * BLOCKER-5: routed through the Aerodrome SLIPSTREAM 0.05% CL pool (tickSpacing 100) —
 * the spec's v2 volatile route has no pool on-chain (verified zero address).
 */
export async function quoteUsdcToBap3x(
  client: PublicClient,
  amountInUsdc: bigint,
  maxSlippageBps: number,
): Promise<SwapQuote> {
  const [out] = (await client.readContract({
    address: SLIPSTREAM.QUOTER as Address,
    abi: SLIPSTREAM_QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: ADDRESSES.USDC as Address,
        tokenOut: ADDRESSES.BAP3X as Address,
        amountIn: amountInUsdc,
        tickSpacing: SLIPSTREAM.TICK_SPACING,
        sqrtPriceLimitX96: 0n,
      },
    ],
  })) as readonly [bigint, bigint, number, bigint];
  if (out === undefined || out === 0n) throw new Error("slipstream quote returned zero output");
  const minOut = (out * BigInt(10_000 - maxSlippageBps)) / 10_000n;
  return { amountInUsdc, amountOutBap3x: out, minOutBap3x: minOut, route: SWAP_ROUTE, slippageBps: maxSlippageBps };
}

/** Legacy SPEC §1.4 v2 quote — kept for reference; throws on-chain today (no pool). */
export async function quoteUsdcToBap3xV2(
  client: PublicClient,
  amountInUsdc: bigint,
  maxSlippageBps: number,
): Promise<SwapQuote> {
  const amounts = (await client.readContract({
    address: ADDRESSES.AERO_ROUTER as Address,
    abi: AERODROME_ROUTER_ABI,
    functionName: "getAmountsOut",
    args: [amountInUsdc, SWAP_ROUTE as unknown as readonly { from: Address; to: Address; stable: boolean; factory: Address }[]],
  })) as readonly bigint[];
  const out = amounts[amounts.length - 1];
  if (out === undefined || out === 0n) throw new Error("aerodrome v2 quote returned zero output (BLOCKER-5: pool does not exist)");
  const minOut = (out * BigInt(10_000 - maxSlippageBps)) / 10_000n;
  return { amountInUsdc, amountOutBap3x: out, minOutBap3x: minOut, route: SWAP_ROUTE, slippageBps: maxSlippageBps };
}

export interface SwapResult {
  approveTx: `0x${string}` | null;
  swapTx: `0x${string}`;
  quote: SwapQuote;
}

/**
 * approve → exactInputSingle on the Slipstream SwapRouter (BLOCKER-5 route).
 * Caller is the hot wallet (REFUEL_LIVE gate sits above this).
 */
export async function swapUsdcToBap3x(
  publicClient: PublicClient,
  walletClient: WalletClient,
  account: Account,
  quote: SwapQuote,
  recipient: Address,
  deadlineSec = 600,
): Promise<SwapResult> {
  const allowance = (await publicClient.readContract({
    address: ADDRESSES.USDC as Address,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account.address, SLIPSTREAM.SWAP_ROUTER as Address],
  })) as bigint;

  let approveTx: `0x${string}` | null = null;
  if (allowance < quote.amountInUsdc) {
    approveTx = await walletClient.writeContract({
      address: ADDRESSES.USDC as Address,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [SLIPSTREAM.SWAP_ROUTER as Address, quote.amountInUsdc],
      account,
      chain: walletClient.chain,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSec);
  const swapTx = await walletClient.writeContract({
    address: SLIPSTREAM.SWAP_ROUTER as Address,
    abi: SLIPSTREAM_ROUTER_ABI,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: ADDRESSES.USDC as Address,
        tokenOut: ADDRESSES.BAP3X as Address,
        tickSpacing: SLIPSTREAM.TICK_SPACING,
        recipient,
        deadline,
        amountIn: quote.amountInUsdc,
        amountOutMinimum: quote.minOutBap3x,
        sqrtPriceLimitX96: 0n,
      },
    ],
    account,
    chain: walletClient.chain,
  });
  await publicClient.waitForTransactionReceipt({ hash: swapTx });
  return { approveTx, swapTx, quote };
}
