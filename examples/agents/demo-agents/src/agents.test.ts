import { describe, expect, it } from "vitest";
import { ALL_AGENTS, NewsSummarizerAgent, StakerAgent, buildAgentServer } from "./index.js";

describe("demo agents", () => {
  it("StakerAgent quotes ~10% APY compounding", async () => {
    const out = (await StakerAgent.handle({ input: { amountAp3x: 1000, days: 365 } })) as { projectedYieldAp3x: number };
    expect(out.projectedYieldAp3x).toBeCloseTo(100, 0);
  });

  it("NewsSummarizerAgent is deterministic and bounded", async () => {
    const text =
      "Apex Fusion launched the Vector agent registry today. Agents now stake AP3X for reputation on-chain. " +
      "The MCP server exposes eighteen tools to any AI client. Analysts expect agent traffic to grow. Extra sentence five here.";
    const out = (await NewsSummarizerAgent.handle({ text })) as { summary: string; headline: string };
    expect(out.summary.split(/(?<=[.!?])\s+/).length).toBeLessThanOrEqual(3);
    expect(out.headline.length).toBeLessThanOrEqual(120);
  });

  it("every agent serves /health and POST / through its Fastify server", async () => {
    for (const agent of ALL_AGENTS) {
      const app = buildAgentServer(agent);
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({ ok: true, agent: agent.name });
      const call = await app.inject({ method: "POST", url: "/", payload: { input: { text: "Hello world. This is a test." } } });
      expect(call.statusCode).toBe(200);
      await app.close();
    }
  });
});
