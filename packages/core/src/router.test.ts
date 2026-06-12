import { describe, expect, it } from "vitest";
import { CircuitBreaker, CIRCUIT_BREAKER, routeAgents, routerScore, type RouterCandidate } from "./router.js";
import type { AgentProfile } from "./schemas/agent.js";

function profile(id: string, overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    agentId: id,
    name: id,
    capabilities: ["x"],
    endpoint: { type: "https", url: `https://agents.example/${id}` },
    pricing: { model: "per_call", amountAp3x: 1 },
    stakeAp3x: 1000,
    ownerPkh: "pkh",
    registeredTx: "tx",
    reputation: { score: 0.5, tasks: 10, disputes: 0 },
    ...overrides,
  };
}

function candidate(id: string, over: Partial<RouterCandidate> = {}): RouterCandidate {
  return {
    profile: profile(id),
    capabilityMatch: 1,
    priceNorm: 0.5,
    latencyNorm: 0.5,
    stakeNorm: 0.5,
    recentFailurePenalty: 0,
    ...over,
  };
}

describe("routerScore", () => {
  it("matches the spec formula on a fixture", () => {
    const c = candidate("a", {
      capabilityMatch: 1,
      priceNorm: 0.2,
      latencyNorm: 0.4,
      stakeNorm: 0.6,
      recentFailurePenalty: 0.05,
    });
    c.profile.reputation.score = 0.8;
    // 0.35·1 + 0.30·0.8 + 0.15·0.8 + 0.10·0.6 + 0.10·0.6 − 0.05
    expect(routerScore(c)).toBeCloseTo(0.35 + 0.24 + 0.12 + 0.06 + 0.06 - 0.05, 10);
  });
});

describe("routeAgents", () => {
  it("ranks deterministically and picks the top without exploration", () => {
    const a = candidate("a");
    a.profile.reputation.score = 0.9;
    const b = candidate("b");
    b.profile.reputation.score = 0.1;
    const result = routeAgents([b, a], { random: () => 0.99 });
    expect(result?.chosen.profile.agentId).toBe("a");
    expect(result?.ranked.map((r) => r.candidate.profile.agentId)).toEqual(["a", "b"]);
    expect(result?.explored).toBe(false);
  });

  it("excludes agents under min stake", () => {
    const low = candidate("low");
    low.profile.stakeAp3x = 100;
    expect(routeAgents([low], { random: () => 0.99 })).toBeNull();
  });

  it("ε-greedy explores ≈10% of the time", () => {
    const a = candidate("a");
    a.profile.reputation.score = 0.9;
    const b = candidate("b");
    b.profile.reputation.score = 0.1;
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    let explored = 0;
    const n = 5000;
    for (let i = 0; i < n; i++) {
      const r = routeAgents([a, b], { random: rand });
      if (r?.explored) explored++;
    }
    const rate = explored / n;
    expect(rate).toBeGreaterThan(0.07);
    expect(rate).toBeLessThan(0.13);
  });
});

describe("CircuitBreaker", () => {
  it("opens after 3 failures in 10 min and recovers after cooldown", () => {
    const cb = new CircuitBreaker();
    const t0 = 1_000_000;
    cb.recordFailure("a", t0);
    cb.recordFailure("a", t0 + 1000);
    expect(cb.isOpen("a", t0 + 2000)).toBe(false);
    cb.recordFailure("a", t0 + 2000);
    expect(cb.isOpen("a", t0 + 3000)).toBe(true);
    expect(cb.isOpen("a", t0 + 2000 + CIRCUIT_BREAKER.cooldownMs + 1)).toBe(false);
  });

  it("forgets failures outside the window", () => {
    const cb = new CircuitBreaker();
    const t0 = 1_000_000;
    cb.recordFailure("a", t0);
    cb.recordFailure("a", t0 + 1);
    cb.recordFailure("a", t0 + CIRCUIT_BREAKER.windowMs + 10);
    expect(cb.isOpen("a", t0 + CIRCUIT_BREAKER.windowMs + 20)).toBe(false);
  });
});
