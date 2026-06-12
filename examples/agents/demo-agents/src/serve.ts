import { ALL_AGENTS, buildAgentServer } from "./index.js";

/** Serve all three demo agents on :5001..:5003 for local E2E. */
const BASE_PORT = Number(process.env.AGENT_BASE_PORT ?? 5001);
for (const [i, agent] of ALL_AGENTS.entries()) {
  const app = buildAgentServer(agent);
  const port = BASE_PORT + i;
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`[demo-agents] ${agent.name} on :${port} (caps: ${agent.capabilities.join(", ")}, ${agent.priceAp3x} AP3X/call)`);
}
