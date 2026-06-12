import Fastify from "fastify";
import { loadEnv } from "@apex/core";
import { KoiosClient } from "@apex/chain-vector";
import { createStore } from "./store/index.js";
import { startPolling } from "./poller.js";
import { startProbing, syncReputation } from "./prober.js";
import { listCatalog } from "./resolver.js";

const env = loadEnv();
const store = createStore(env.DATABASE_URL);
const koios = new KoiosClient({ baseUrl: env.KOIOS_URL });
const log = (msg: string) => console.log(`[indexer] ${msg}`);

const poller = startPolling({
  koios,
  store,
  registryScriptAddr: env.REGISTRY_SCRIPT_ADDR,
  registryPolicy: env.REGISTRY_POLICY,
  log,
});
const prober = startProbing({ store, log });

if (env.VERIFICATION_API) {
  setInterval(() => void syncReputation(store, env.VERIFICATION_API!, fetch, log), 10 * 60 * 1000);
}

const app = Fastify({ logger: false });
app.get("/health", async () => ({ ok: true, service: "indexer", network: env.VECTOR_NETWORK }));
app.get("/agents", async (req) => {
  const { capability } = req.query as { capability?: string };
  return listCatalog(store, capability ? { capability } : undefined);
});

const close = async () => {
  poller.stop();
  prober.stop();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", close);
process.on("SIGTERM", close);

await app.listen({ port: env.INDEXER_PORT, host: "0.0.0.0" });
log(`listening on :${env.INDEXER_PORT}, koios=${env.KOIOS_URL}`);
