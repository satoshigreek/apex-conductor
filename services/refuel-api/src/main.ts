import { createPublicClient, createWalletClient, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { loadEnv } from "@apex/core";
import { createBridgeAdapter } from "./bridges.js";
import { MemoryGasLedger } from "./gasledger.js";
import { buildRefuelServer } from "./server.js";

const env = loadEnv();
const log = (msg: string) => console.log(`[refuel-api] ${msg}`);

const publicClient = createPublicClient({ chain: base, transport: http(env.BASE_RPC) }) as PublicClient;
const account = env.BASE_HOT_WALLET_PK ? privateKeyToAccount(env.BASE_HOT_WALLET_PK as `0x${string}`) : null;
const walletClient = account ? createWalletClient({ chain: base, transport: http(env.BASE_RPC), account }) : null;

if (env.REFUEL_LIVE && !account) {
  throw new Error("REFUEL_LIVE=true requires BASE_HOT_WALLET_PK");
}
log(`mode: ${env.REFUEL_LIVE ? "LIVE" : "dry-run (quote+simulate)"} · bridge: ${env.BRIDGE_MODE}`);

const app = buildRefuelServer({
  refuel: {
    publicClient,
    walletClient,
    account,
    bridge: createBridgeAdapter(env.BRIDGE_MODE, env.SKYLINE_API),
    ledger: new MemoryGasLedger(),
    live: env.REFUEL_LIVE,
    log,
  },
  payTo: (env.REFUEL_PAYTO as `0x${string}` | undefined) ?? null,
  facilitatorUrl: env.X402_FACILITATOR_URL,
  usdcPerAp3x: 0.01, // ops pricing knob: 1 USDC = 100 AP3X gas credit until live quotes wire in
  maxTopupUsdc: "100000000", // 100 USDC cap per x402 call
});

await app.listen({ port: env.REFUEL_PORT, host: "0.0.0.0" });
log(`listening on :${env.REFUEL_PORT}`);
