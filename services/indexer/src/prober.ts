import type { AgentStore } from "./store/index.js";

/** SPEC §5.1 — heartbeat prober: GET /health every 5 min; stale after 15 min silence. */
export interface ProberOptions {
  store: AgentStore;
  intervalMs?: number;
  staleAfterMs?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

export async function probeOnce(opts: ProberOptions, now = new Date()): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const staleAfter = opts.staleAfterMs ?? 15 * 60 * 1000;
  const agents = await opts.store.listAgents();
  for (const agent of agents) {
    if (!agent.endpointUrl) continue;
    let healthy = false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
      const url = `${agent.endpointUrl.replace(/\/$/, "")}/health`;
      const res = await fetchImpl(url, { method: "GET", signal: controller.signal });
      clearTimeout(timer);
      healthy = res.ok;
    } catch {
      healthy = false;
    }
    if (healthy) {
      await opts.store.setHeartbeat(agent.agentId, now, "active");
    } else {
      const last = agent.lastHeartbeat?.getTime() ?? 0;
      // cooldown is the router's circuit-breaker state — the prober never overrides it
      if (now.getTime() - last > staleAfter && agent.status !== "cooldown") {
        await opts.store.setHeartbeat(agent.agentId, agent.lastHeartbeat ?? now, "stale");
      }
    }
  }
}

export function startProbing(opts: ProberOptions): { stop: () => void } {
  const interval = opts.intervalMs ?? 5 * 60 * 1000;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const tick = async () => {
    try {
      await probeOnce(opts);
    } catch (err) {
      opts.log?.(`prober error: ${(err as Error).message}`);
    }
    if (!stopped) timer = setTimeout(tick, interval);
  };
  void tick();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/** SPEC §5.1 — reputation sync; if unreachable, keep last known, never zero out. */
export async function syncReputation(
  store: AgentStore,
  verificationApi: string,
  fetchImpl: typeof fetch = fetch,
  log?: (msg: string) => void,
): Promise<void> {
  try {
    const res = await fetchImpl(`${verificationApi.replace(/\/$/, "")}/scores`, { method: "GET" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const scores = (await res.json()) as Array<{ agentId: string; score: number; tasks?: number; disputes?: number }>;
    for (const s of scores) {
      if (typeof s.agentId === "string" && typeof s.score === "number" && s.score >= 0 && s.score <= 1) {
        await store.setReputation(s.agentId, s.score, s.tasks ?? 0, s.disputes ?? 0);
      }
    }
  } catch (err) {
    log?.(`reputation sync failed, keeping last known scores: ${(err as Error).message}`);
  }
}
