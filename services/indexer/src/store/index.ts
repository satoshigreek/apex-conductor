import pg from "pg";
import type { AgentManifest, AgentStatus } from "@apex/core";

/** Row shape mirroring SPEC §3 `agents`. */
export interface AgentRow {
  agentId: string;
  name: string | null;
  capabilities: string[];
  endpointType: string | null;
  endpointUrl: string | null;
  pricingModel: string | null;
  priceAp3x: number | null;
  stakeAp3x: number | null;
  ownerPkh: string | null;
  registeredTx: string | null;
  reputation: number;
  repTasks: number;
  repDisputes: number;
  lastHeartbeat: Date | null;
  status: AgentStatus;
  rawDatum: unknown;
  updatedAt: Date;
}

export interface AgentStore {
  upsertAgent(row: Omit<AgentRow, "updatedAt">): Promise<void>;
  listAgents(filter?: { capability?: string; status?: AgentStatus }): Promise<AgentRow[]>;
  getAgent(agentId: string): Promise<AgentRow | null>;
  /** remove agents whose registry UTxO disappeared */
  pruneAbsent(presentIds: string[]): Promise<number>;
  setHeartbeat(agentId: string, at: Date, status: AgentStatus): Promise<void>;
  setReputation(agentId: string, score: number, tasks: number, disputes: number): Promise<void>;
  upsertManifest(manifest: AgentManifest & { verified: boolean }): Promise<void>;
  getManifest(agentId: string): Promise<(AgentManifest & { verified: boolean }) | null>;
}

/** In-memory store — dev fallback when DATABASE_URL=memory:// (no Docker on the box). */
export class MemoryAgentStore implements AgentStore {
  private agents = new Map<string, AgentRow>();
  private manifests = new Map<string, AgentManifest & { verified: boolean }>();

  async upsertAgent(row: Omit<AgentRow, "updatedAt">): Promise<void> {
    const existing = this.agents.get(row.agentId);
    this.agents.set(row.agentId, {
      ...row,
      // datum poll must not clobber prober/reputation state (SPEC §5.1: never zero out)
      reputation: existing?.reputation ?? row.reputation,
      repTasks: existing?.repTasks ?? row.repTasks,
      repDisputes: existing?.repDisputes ?? row.repDisputes,
      lastHeartbeat: existing?.lastHeartbeat ?? row.lastHeartbeat,
      status: existing?.status ?? row.status,
      updatedAt: new Date(),
    });
  }

  async listAgents(filter?: { capability?: string; status?: AgentStatus }): Promise<AgentRow[]> {
    let rows = [...this.agents.values()];
    if (filter?.capability) rows = rows.filter((r) => r.capabilities.includes(filter.capability!));
    if (filter?.status) rows = rows.filter((r) => r.status === filter.status);
    return rows.sort((a, b) => a.agentId.localeCompare(b.agentId));
  }

  async getAgent(agentId: string): Promise<AgentRow | null> {
    return this.agents.get(agentId) ?? null;
  }

  async pruneAbsent(presentIds: string[]): Promise<number> {
    const present = new Set(presentIds);
    let pruned = 0;
    for (const id of this.agents.keys()) {
      if (!present.has(id)) {
        this.agents.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  async setHeartbeat(agentId: string, at: Date, status: AgentStatus): Promise<void> {
    const row = this.agents.get(agentId);
    if (row) {
      row.lastHeartbeat = at;
      row.status = status;
    }
  }

  async setReputation(agentId: string, score: number, tasks: number, disputes: number): Promise<void> {
    const row = this.agents.get(agentId);
    if (row) {
      row.reputation = score;
      row.repTasks = tasks;
      row.repDisputes = disputes;
    }
  }

  async upsertManifest(manifest: AgentManifest & { verified: boolean }): Promise<void> {
    this.manifests.set(manifest.agentId, manifest);
  }

  async getManifest(agentId: string): Promise<(AgentManifest & { verified: boolean }) | null> {
    return this.manifests.get(agentId) ?? null;
  }
}

/** Postgres store (SPEC §3 schema; migrations in infra/migrations). */
export class PgAgentStore implements AgentStore {
  constructor(private pool: pg.Pool) {}

  static fromUrl(databaseUrl: string): PgAgentStore {
    return new PgAgentStore(new pg.Pool({ connectionString: databaseUrl }));
  }

  async upsertAgent(row: Omit<AgentRow, "updatedAt">): Promise<void> {
    await this.pool.query(
      `INSERT INTO agents (agent_id, name, capabilities, endpoint_type, endpoint_url, pricing_model,
         price_ap3x, stake_ap3x, owner_pkh, registered_tx, raw_datum, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       ON CONFLICT (agent_id) DO UPDATE SET
         name = EXCLUDED.name, capabilities = EXCLUDED.capabilities,
         endpoint_type = EXCLUDED.endpoint_type, endpoint_url = EXCLUDED.endpoint_url,
         pricing_model = EXCLUDED.pricing_model, price_ap3x = EXCLUDED.price_ap3x,
         stake_ap3x = EXCLUDED.stake_ap3x, owner_pkh = EXCLUDED.owner_pkh,
         registered_tx = EXCLUDED.registered_tx, raw_datum = EXCLUDED.raw_datum, updated_at = now()`,
      [
        row.agentId,
        row.name,
        row.capabilities,
        row.endpointType,
        row.endpointUrl,
        row.pricingModel,
        row.priceAp3x,
        row.stakeAp3x,
        row.ownerPkh,
        row.registeredTx,
        JSON.stringify(row.rawDatum ?? null),
      ],
    );
  }

  private rowFromDb(r: Record<string, unknown>): AgentRow {
    return {
      agentId: r.agent_id as string,
      name: r.name as string | null,
      capabilities: (r.capabilities as string[]) ?? [],
      endpointType: r.endpoint_type as string | null,
      endpointUrl: r.endpoint_url as string | null,
      pricingModel: r.pricing_model as string | null,
      priceAp3x: r.price_ap3x === null ? null : Number(r.price_ap3x),
      stakeAp3x: r.stake_ap3x === null ? null : Number(r.stake_ap3x),
      ownerPkh: r.owner_pkh as string | null,
      registeredTx: r.registered_tx as string | null,
      reputation: Number(r.reputation),
      repTasks: Number(r.rep_tasks),
      repDisputes: Number(r.rep_disputes),
      lastHeartbeat: r.last_heartbeat as Date | null,
      status: r.status as AgentStatus,
      rawDatum: r.raw_datum,
      updatedAt: r.updated_at as Date,
    };
  }

  async listAgents(filter?: { capability?: string; status?: AgentStatus }): Promise<AgentRow[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter?.capability) {
      args.push(filter.capability);
      where.push(`$${args.length} = ANY(capabilities)`);
    }
    if (filter?.status) {
      args.push(filter.status);
      where.push(`status = $${args.length}`);
    }
    const sql = `SELECT * FROM agents ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY agent_id`;
    return (await this.pool.query(sql, args)).rows.map((r) => this.rowFromDb(r));
  }

  async getAgent(agentId: string): Promise<AgentRow | null> {
    const res = await this.pool.query(`SELECT * FROM agents WHERE agent_id = $1`, [agentId]);
    return res.rows[0] ? this.rowFromDb(res.rows[0]) : null;
  }

  async pruneAbsent(presentIds: string[]): Promise<number> {
    const res = await this.pool.query(`DELETE FROM agents WHERE NOT (agent_id = ANY($1::text[]))`, [presentIds]);
    return res.rowCount ?? 0;
  }

  async setHeartbeat(agentId: string, at: Date, status: AgentStatus): Promise<void> {
    await this.pool.query(`UPDATE agents SET last_heartbeat = $2, status = $3, updated_at = now() WHERE agent_id = $1`, [
      agentId,
      at,
      status,
    ]);
  }

  async setReputation(agentId: string, score: number, tasks: number, disputes: number): Promise<void> {
    await this.pool.query(
      `UPDATE agents SET reputation = $2, rep_tasks = $3, rep_disputes = $4, updated_at = now() WHERE agent_id = $1`,
      [agentId, score, tasks, disputes],
    );
  }

  async upsertManifest(m: AgentManifest & { verified: boolean }): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_manifests (agent_id, endpoint_type, endpoint_url, pricing_model, price_ap3x, signature, public_key, verified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (agent_id) DO UPDATE SET endpoint_type=$2, endpoint_url=$3, pricing_model=$4, price_ap3x=$5,
         signature=$6, public_key=$7, verified=$8`,
      [m.agentId, m.endpoint.type, m.endpoint.url, m.pricing.model, m.pricing.amountAp3x, m.signature, m.publicKey, m.verified],
    );
  }

  async getManifest(agentId: string): Promise<(AgentManifest & { verified: boolean }) | null> {
    const res = await this.pool.query(`SELECT * FROM agent_manifests WHERE agent_id = $1`, [agentId]);
    const r = res.rows[0];
    if (!r) return null;
    return {
      agentId: r.agent_id,
      endpoint: { type: r.endpoint_type, url: r.endpoint_url },
      pricing: { model: r.pricing_model, amountAp3x: Number(r.price_ap3x) },
      signature: r.signature,
      publicKey: r.public_key,
      verified: r.verified,
    };
  }
}

export function createStore(databaseUrl: string): AgentStore {
  return databaseUrl.startsWith("memory://") ? new MemoryAgentStore() : PgAgentStore.fromUrl(databaseUrl);
}
