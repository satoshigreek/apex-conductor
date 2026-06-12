import type { AgentProfile } from "./schemas/agent.js";

/** SPEC §4.3 — router score. All weights fixed by spec. */
export const ROUTER_WEIGHTS = {
  capabilityMatch: 0.35,
  reputation: 0.3,
  price: 0.15,
  latency: 0.1,
  stake: 0.1,
} as const;

export interface RouterCandidate {
  profile: AgentProfile;
  /** 0..1 — fraction of required capabilities the agent covers */
  capabilityMatch: number;
  /** normalized 0..1 within the candidate set (1 = most expensive) */
  priceNorm: number;
  /** normalized 0..1 within the candidate set (1 = slowest) */
  latencyNorm: number;
  /** normalized 0..1 within the candidate set (1 = highest stake) */
  stakeNorm: number;
  recentFailurePenalty: number;
}

export function routerScore(c: RouterCandidate): number {
  return (
    ROUTER_WEIGHTS.capabilityMatch * c.capabilityMatch +
    ROUTER_WEIGHTS.reputation * c.profile.reputation.score +
    ROUTER_WEIGHTS.price * (1 - c.priceNorm) +
    ROUTER_WEIGHTS.latency * (1 - c.latencyNorm) +
    ROUTER_WEIGHTS.stake * c.stakeNorm -
    c.recentFailurePenalty
  );
}

export interface RouteOptions {
  /** ε-greedy exploration rate; SPEC default 0.10 */
  epsilon?: number;
  /** SPEC: min stake to be routable (ROUTER_MIN_STAKE_AP3X, default 500) */
  minStakeAp3x?: number;
  /** injectable for deterministic tests */
  random?: () => number;
}

export interface RouteResult {
  chosen: RouterCandidate;
  ranked: Array<{ candidate: RouterCandidate; score: number }>;
  explored: boolean;
}

/** Rank by score; with probability ε pick a uniformly random non-top candidate (exploration). */
export function routeAgents(candidates: RouterCandidate[], opts: RouteOptions = {}): RouteResult | null {
  const epsilon = opts.epsilon ?? 0.1;
  const minStake = opts.minStakeAp3x ?? 500;
  const random = opts.random ?? Math.random;

  const eligible = candidates.filter((c) => c.profile.stakeAp3x >= minStake);
  if (eligible.length === 0) return null;

  const ranked = eligible
    .map((candidate) => ({ candidate, score: routerScore(candidate) }))
    .sort((a, b) => b.score - a.score);

  const explore = ranked.length > 1 && random() < epsilon;
  if (!explore) return { chosen: ranked[0]!.candidate, ranked, explored: false };

  const rest = ranked.slice(1);
  const pick = rest[Math.min(rest.length - 1, Math.floor(random() * rest.length))]!;
  return { chosen: pick.candidate, ranked, explored: true };
}

/** SPEC §4.3 — circuit breaker: 3 failures / 10 min → cooldown 15 min. */
export const CIRCUIT_BREAKER = {
  failureThreshold: 3,
  windowMs: 10 * 60 * 1000,
  cooldownMs: 15 * 60 * 1000,
} as const;

export class CircuitBreaker {
  private failures = new Map<string, number[]>();
  private cooldownUntil = new Map<string, number>();

  recordFailure(agentId: string, now = Date.now()): void {
    const cutoff = now - CIRCUIT_BREAKER.windowMs;
    const list = (this.failures.get(agentId) ?? []).filter((t) => t > cutoff);
    list.push(now);
    this.failures.set(agentId, list);
    if (list.length >= CIRCUIT_BREAKER.failureThreshold) {
      this.cooldownUntil.set(agentId, now + CIRCUIT_BREAKER.cooldownMs);
      this.failures.set(agentId, []);
    }
  }

  recordSuccess(agentId: string): void {
    this.failures.delete(agentId);
  }

  isOpen(agentId: string, now = Date.now()): boolean {
    const until = this.cooldownUntil.get(agentId);
    if (until === undefined) return false;
    if (now >= until) {
      this.cooldownUntil.delete(agentId);
      return false;
    }
    return true;
  }
}
