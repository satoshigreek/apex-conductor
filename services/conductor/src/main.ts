import { loadEnv, DEFAULT_POLICY, type SpendPolicy } from "@apex/core";
import { KoiosClient, MockVectorWallet } from "@apex/chain-vector";
import { createProvider, type LlmProvider } from "@apex/llm";
import { createStore, listCatalog, resolveAll, startPolling, startProbing } from "@apex/indexer";
import { MemoryTaskStore } from "./taskstore.js";
import { Orchestrator } from "./orchestrator.js";
import { StubChainTools } from "./executor.js";
import { buildServer } from "./server.js";
import { registerMcp } from "./mcp.js";

const env = loadEnv();
const log = (msg: string) => console.log(`[conductor] ${msg}`);

const policy: SpendPolicy = {
  checkpointAp3x: env.CHECKPOINT_AP3X,
  perTaskCapAp3x: env.PER_TASK_CAP_AP3X,
  perSessionCapAp3x: env.PER_SESSION_CAP_AP3X,
  dailyCapAp3x: env.DAILY_CAP_AP3X,
  protocolFeeBps: env.PROTOCOL_FEE_BPS,
};

// catalog: shared DB with the indexer service; with memory:// we run the poll loop in-process
const agentStore = createStore(env.DATABASE_URL);
if (env.DATABASE_URL.startsWith("memory://")) {
  log("DATABASE_URL=memory:// — running registry indexer in-process (dev single-process mode)");
  const koios = new KoiosClient({ baseUrl: env.KOIOS_URL });
  startPolling({
    koios,
    store: agentStore,
    registryScriptAddr: env.REGISTRY_SCRIPT_ADDR,
    registryPolicy: env.REGISTRY_POLICY,
    log,
  });
  startProbing({ store: agentStore, log });
}

function makeProvider(): LlmProvider | null {
  const key =
    env.LLM_PROVIDER === "anthropic" ? env.ANTHROPIC_API_KEY : env.LLM_PROVIDER === "venice" ? env.VENICE_API_KEY : env.OPENAI_API_KEY;
  if (!key) return null;
  return createProvider({ provider: env.LLM_PROVIDER, apiKey: key });
}
const provider = makeProvider();
if (!provider) log("no LLM API key configured — planner disabled; intents must carry a direct plan (dev mode)");

// real Vector wallet (agent-sdk / Lucid Evolution) when a mnemonic is configured; mock otherwise
import { SdkVectorWallet } from "@apex/chain-vector";
import type { VectorWallet } from "@apex/chain-vector";
let wallet: VectorWallet;
if (env.VECTOR_HOT_WALLET_MNEMONIC) {
  wallet = await SdkVectorWallet.create({
    mnemonic: env.VECTOR_HOT_WALLET_MNEMONIC,
    ogmiosUrl: env.OGMIOS_URL,
    submitUrl: env.TXSUBMIT_URL,
    koiosUrl: env.KOIOS_URL,
    spendLimitPerTx: env.PER_TASK_CAP_AP3X * 1_000_000,
    spendLimitDaily: env.DAILY_CAP_AP3X * 1_000_000,
  });
  log(`SDK wallet active: ${await wallet.address()}`);
} else {
  wallet = new MockVectorWallet();
  log("no VECTOR_HOT_WALLET_MNEMONIC — mock wallet (payments/anchors recorded, not submitted)");
}

const taskStore = new MemoryTaskStore();
const resolveOpts = { trustUnverified: env.ALLOW_UNVERIFIED_MANIFESTS };
if (env.ALLOW_UNVERIFIED_MANIFESTS) log("WARNING: ALLOW_UNVERIFIED_MANIFESTS=true — dev only, never in production");
const catalog = async () => {
  const minStake = env.ROUTER_MIN_STAKE_AP3X;
  const resolved = await resolveAll(agentStore, undefined, resolveOpts);
  return resolved.filter((r) => r.row.status === "active" && r.profile.stakeAp3x >= minStake).map((r) => r.profile);
};

const orchestrator: Orchestrator = new Orchestrator({
  store: taskStore,
  wallet,
  policy,
  catalog,
  planner: provider ? { provider, model: env.PLANNER_MODEL } : null,
  worker: provider ? { provider, workerModel: env.WORKER_MODEL } : null,
  chainTools: new StubChainTools(),
  treasuryAddr: env.PROTOCOL_TREASURY_ADDR ?? null,
  perTaskCapAp3x: env.PER_TASK_CAP_AP3X,
  enqueue:
    env.QUEUE_DRIVER === "bullmq"
      ? async (taskId) => {
          const { BullMqTaskQueue } = await import("./queue.js");
          queue ??= new BullMqTaskQueue(
            env.REDIS_URL,
            (id) => orchestrator.executor.executeTask(id),
            async (id, err) => {
              await taskStore.updateTask(id, { status: "failed", error: err.message });
            },
          );
          await queue.enqueue(taskId);
        }
      : undefined,
  log,
});
let queue: import("./queue.js").BullMqTaskQueue | null = null;

const app = buildServer({
  orchestrator,
  store: taskStore,
  agentStore,
  resolveAgents: (capability) => listCatalog(agentStore, capability ? { capability } : undefined, resolveOpts),
  apiKeys: (process.env.CONDUCTOR_API_KEYS ?? "").split(",").filter(Boolean),
});
registerMcp(app, orchestrator, taskStore);

await app.listen({ port: env.CONDUCTOR_PORT, host: "0.0.0.0" });
log(`listening on :${env.CONDUCTOR_PORT} (network=${env.VECTOR_NETWORK}, koios=${env.KOIOS_URL})`);
