/** SPEC §1.4 — Base mainnet (chainId 8453). Do not invent addresses. */
export const BASE_CHAIN_ID = 8453;

export const ADDRESSES = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  BAP3X: "0x9208d82f121806a34a39bb90733b4c5c54f3993e",
  AERO_ROUTER: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
  AERO_FACTORY: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
} as const;

export const USDC_DECIMALS = 6;
export const BAP3X_DECIMALS = 18;

/** SPEC §1.4 swap route: USDC → bAP3X, volatile pool, default factory. */
export const SWAP_ROUTE = [
  { from: ADDRESSES.USDC, to: ADDRESSES.BAP3X, stable: false, factory: ADDRESSES.AERO_FACTORY },
] as const;

/**
 * BLOCKER-5 (found live 2026-06-12): the SPEC §1.4 v2 route does NOT exist on-chain —
 * Aerodrome default factory getPool(USDC, bAP3X, stable∈{true,false}) = 0x0. The real
 * bAP3X/USDC liquidity (~$150k) is the Aerodrome SLIPSTREAM (CL) 0.05% pool. All
 * addresses below verified on-chain (router/quoter factory() == pool factory).
 */
export const SLIPSTREAM = {
  FACTORY: "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A",
  SWAP_ROUTER: "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5",
  QUOTER: "0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0",
  POOL_USDC_BAP3X: "0x5b8bf0cd0fa5bf970ebe558d7551a668dadf3570",
  TICK_SPACING: 100,
} as const;

export const SLIPSTREAM_QUOTER_ABI = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "view", // declared view so eth_call works; on-chain it's the standard QuoterV2 revert trick
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "tickSpacing", type: "int24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

export const SLIPSTREAM_ROUTER_ABI = [
  {
    name: "exactInputSingle",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "tickSpacing", type: "int24" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

/** SPEC §5.3 — EIP-3009 domain for USDC on Base. */
export const USDC_EIP3009_DOMAIN = {
  name: "USD Coin",
  version: "2",
  chainId: BASE_CHAIN_ID,
  verifyingContract: ADDRESSES.USDC,
} as const;

export const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "transferWithAuthorization",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

export const AERODROME_ROUTER_ABI = [
  {
    name: "getAmountsOut",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      {
        name: "routes",
        type: "tuple[]",
        components: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "stable", type: "bool" },
          { name: "factory", type: "address" },
        ],
      },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
  {
    name: "swapExactTokensForTokens",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      {
        name: "routes",
        type: "tuple[]",
        components: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "stable", type: "bool" },
          { name: "factory", type: "address" },
        ],
      },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
] as const;
