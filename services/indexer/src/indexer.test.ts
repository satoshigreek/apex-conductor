import { describe, expect, it, vi } from "vitest";
import { KoiosClient } from "@apex/chain-vector";
import { MemoryAgentStore } from "./store/index.js";
import { agentIdFromUtxo, pollOnce } from "./poller.js";
import { resolveAgent, resolveAll } from "./resolver.js";
import { probeOnce } from "./prober.js";

const hex = (s: string) => Buffer.from(s, "utf8").toString("hex");
const POLICY = "be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01";
const ADDR = "addr1wxlp5z3fztdpsp6ha57dvx6khw82kqvgcxwu8s8rjykjcqghprf42";

function registryUtxo(name: string, withEndpoint: boolean) {
  return {
    tx_hash: `tx_${name}`,
    tx_index: 0,
    value: "2000000",
    asset_list: [{ policy_id: POLICY, asset_name: hex(name), quantity: "1" }],
    inline_datum: {
      bytes: "00",
      value: {
        constructor: 0,
        fields: [
          {
            map: [
              { k: { bytes: hex("name") }, v: { bytes: hex(name) } },
              ...(withEndpoint ? [{ k: { bytes: hex("endpoint") }, v: { bytes: hex(`https://${name}.example`) } }] : []),
              { k: { bytes: hex("stake") }, v: { int: 800 } },
              { k: { bytes: hex("capabilities") }, v: { list: [{ bytes: hex("news") }] } },
            ],
          },
        ],
      },
    },
  };
}

function koiosReturning(utxos: unknown[]): KoiosClient {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(utxos), { status: 200 })) as unknown as typeof fetch;
  return new KoiosClient({ baseUrl: "https://koios.example", fetchImpl });
}

describe("agentIdFromUtxo", () => {
  it("prefers the registry asset id, falls back to utxo ref", () => {
    const utxo = registryUtxo("AgentA", true);
    expect(agentIdFromUtxo(utxo as never, POLICY)).toBe(`${POLICY}.${hex("AgentA")}`);
    expect(agentIdFromUtxo({ tx_hash: "t", tx_index: 3, value: "1" } as never, POLICY)).toBe("utxo:t#3");
  });
});

describe("pollOnce", () => {
  it("upserts agents from registry UTxOs and prunes absentees", async () => {
    const store = new MemoryAgentStore();
    const opts = { store, registryScriptAddr: ADDR, registryPolicy: POLICY };

    let result = await pollOnce({ ...opts, koios: koiosReturning([registryUtxo("AgentA", true), registryUtxo("AgentB", false)]) });
    expect(result).toEqual({ seen: 2, pruned: 0 });
    expect((await store.listAgents()).map((a) => a.name).sort()).toEqual(["AgentA", "AgentB"]);

    result = await pollOnce({ ...opts, koios: koiosReturning([registryUtxo("AgentA", true)]) });
    expect(result).toEqual({ seen: 1, pruned: 1 });
  });

  it("re-poll preserves prober/reputation state", async () => {
    const store = new MemoryAgentStore();
    const opts = { store, registryScriptAddr: ADDR, registryPolicy: POLICY };
    await pollOnce({ ...opts, koios: koiosReturning([registryUtxo("AgentA", true)]) });
    const id = `${POLICY}.${hex("AgentA")}`;
    await store.setReputation(id, 0.9, 12, 1);
    await store.setHeartbeat(id, new Date("2026-06-12T00:00:00Z"), "active");
    await pollOnce({ ...opts, koios: koiosReturning([registryUtxo("AgentA", true)]) });
    const row = await store.getAgent(id);
    expect(row?.reputation).toBe(0.9);
    expect(row?.lastHeartbeat?.toISOString()).toBe("2026-06-12T00:00:00.000Z");
  });
});

describe("resolveAgent (BLOCKER-3 paths)", () => {
  it("uses datum endpoint when present", async () => {
    const store = new MemoryAgentStore();
    await pollOnce({ store, registryScriptAddr: ADDR, registryPolicy: POLICY, koios: koiosReturning([registryUtxo("AgentA", true)]) });
    const [row] = await store.listAgents();
    const resolved = await resolveAgent(store, row!);
    expect(resolved?.source.endpoint).toBe("datum");
    expect(resolved?.profile.endpoint.url).toBe("https://AgentA.example");
  });

  it("falls back to a verified manifest, skips unverified, drops endpointless agents", async () => {
    const store = new MemoryAgentStore();
    await pollOnce({ store, registryScriptAddr: ADDR, registryPolicy: POLICY, koios: koiosReturning([registryUtxo("AgentB", false)]) });
    const [row] = await store.listAgents();
    expect(await resolveAgent(store, row!)).toBeNull();

    await store.upsertManifest({
      agentId: row!.agentId,
      endpoint: { type: "https", url: "https://manifest.example" },
      pricing: { model: "per_call", amountAp3x: 2 },
      signature: "sig",
      publicKey: "pk",
      verified: false,
    });
    expect(await resolveAgent(store, row!)).toBeNull(); // unverified manifest is not trusted

    await store.upsertManifest({
      agentId: row!.agentId,
      endpoint: { type: "https", url: "https://manifest.example" },
      pricing: { model: "per_call", amountAp3x: 2 },
      signature: "sig",
      publicKey: "pk",
      verified: true,
    });
    const resolved = await resolveAgent(store, row!);
    expect(resolved?.source).toEqual({ endpoint: "manifest", pricing: "manifest" });
    expect((await resolveAll(store)).length).toBe(1);
  });
});

describe("probeOnce", () => {
  it("marks healthy agents active and silent ones stale after the window", async () => {
    const store = new MemoryAgentStore();
    await pollOnce({ store, registryScriptAddr: ADDR, registryPolicy: POLICY, koios: koiosReturning([registryUtxo("AgentA", true)]) });
    const id = `${POLICY}.${hex("AgentA")}`;

    const healthyFetch = vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    await probeOnce({ store, fetchImpl: healthyFetch }, new Date("2026-06-12T10:00:00Z"));
    expect((await store.getAgent(id))?.status).toBe("active");

    const deadFetch = vi.fn(async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    await probeOnce({ store, fetchImpl: deadFetch }, new Date("2026-06-12T10:20:00Z")); // >15 min since heartbeat
    expect((await store.getAgent(id))?.status).toBe("stale");
  });
});
