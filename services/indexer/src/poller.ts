import { KoiosClient, decodeAgentDatum, type KoiosUtxo } from "@apex/chain-vector";
import type { AgentStore } from "./store/index.js";

export interface PollerOptions {
  koios: KoiosClient;
  store: AgentStore;
  registryScriptAddr: string;
  registryPolicy: string;
  /** SPEC §5.1 — poll every 60s; poll is the source of truth (Ogmios follow is best-effort, M2+) */
  intervalMs?: number;
  log?: (msg: string) => void;
}

/** agent_id = asset id (policy.assetNameHex) when a registry-policy asset sits on the UTxO, else utxo ref */
export function agentIdFromUtxo(utxo: KoiosUtxo, registryPolicy: string): string {
  const asset = utxo.asset_list?.find((a) => a.policy_id === registryPolicy);
  if (asset) return `${asset.policy_id}.${asset.asset_name ?? ""}`;
  return `utxo:${utxo.tx_hash}#${utxo.tx_index}`;
}

export async function pollOnce(opts: PollerOptions): Promise<{ seen: number; pruned: number }> {
  const utxos = await opts.koios.addressUtxos(opts.registryScriptAddr, true);
  const presentIds: string[] = [];
  for (const utxo of utxos) {
    const agentId = agentIdFromUtxo(utxo, opts.registryPolicy);
    presentIds.push(agentId);
    const datum = utxo.inline_datum?.value ?? null;
    const raw = decodeAgentDatum(datum);
    await opts.store.upsertAgent({
      agentId,
      name: raw.name,
      capabilities: raw.capabilities,
      endpointType: raw.endpointType,
      endpointUrl: raw.endpointUrl,
      pricingModel: raw.pricingModel,
      priceAp3x: raw.pricingAmount,
      stakeAp3x: raw.stake,
      ownerPkh: raw.ownerPkh,
      registeredTx: utxo.tx_hash,
      reputation: 0.5,
      repTasks: 0,
      repDisputes: 0,
      lastHeartbeat: null,
      status: "active",
      rawDatum: raw.decoded,
    });
  }
  const pruned = await opts.store.pruneAbsent(presentIds);
  opts.log?.(`registry poll: ${utxos.length} utxos, ${presentIds.length} agents, pruned ${pruned}`);
  return { seen: presentIds.length, pruned };
}

export function startPolling(opts: PollerOptions): { stop: () => void } {
  const interval = opts.intervalMs ?? 60_000;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const tick = async () => {
    try {
      await pollOnce(opts);
    } catch (err) {
      opts.log?.(`registry poll failed (keeping last known state): ${(err as Error).message}`);
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
