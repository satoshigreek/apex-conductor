/**
 * SPEC M2 — self-register the three demo agents on the TESTNET registry via the
 * official SDK (each datum carries name/description/capabilities/framework/endpoint).
 *
 * Prereqs:
 *   1. AGENT_MNEMONIC env (testnet wallet)
 *   2. Fund it: https://apex-fusion.github.io/vector-ai-documentation/quickstart/faucet/
 *   3. AGENT_PUBLIC_URL env — publicly reachable base URL for the served agents
 *
 * Run: AGENT_MNEMONIC="..." AGENT_PUBLIC_URL="https://host" pnpm --filter @apex/demo-agents exec tsx src/register.ts
 */
import { ALL_AGENTS } from "./index.js";

const mnemonic = process.env.AGENT_MNEMONIC;
const publicUrl = process.env.AGENT_PUBLIC_URL ?? "http://localhost:5001";
if (!mnemonic) {
  console.error("AGENT_MNEMONIC is required (testnet wallet — fund via the faucet first)");
  process.exit(1);
}

const { VectorAgent } = await import("@apexfusion/agent-sdk");
const agent = new VectorAgent({ mnemonic }); // SDK defaults = Vector testnet endpoints

console.log(`registering from ${await agent.getAddress()}`);
const balance = await agent.getBalance();
console.log(`balance: ${balance.ada} AP3X (testnet)`);

const basePort = Number(process.env.AGENT_BASE_PORT ?? 5001);
for (const [i, demo] of ALL_AGENTS.entries()) {
  const endpoint = publicUrl.includes("localhost") ? `${publicUrl.replace(/:\d+$/, "")}:${basePort + i}` : `${publicUrl}/${demo.name.toLowerCase()}`;
  const result = await agent.registerAgent({
    name: demo.name,
    description: `Apex Conductor first-party demo agent (${demo.capabilities.join(", ")}) — ${demo.priceAp3x} AP3X/call`,
    capabilities: demo.capabilities,
    framework: "apex-conductor",
    endpoint,
  });
  console.log(`${demo.name}: registered → ${JSON.stringify(result)}`);
}
await agent.close();
console.log("done — the indexer will pick these up on its next poll");
