import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { TaskModeSchema } from "@apex/core";
import type { ResolvedAgent } from "@apex/indexer";
import type { Orchestrator } from "./orchestrator.js";
import type { TaskStore } from "./taskstore.js";

/** SPEC §5.2 APIs — Fastify; API keys (hashed) + rate limit per key; SSE events; webhooks. */
export interface ServerDeps {
  orchestrator: Orchestrator;
  store: TaskStore;
  resolveAgents: (capability?: string) => Promise<ResolvedAgent[]>;
  /** "key" or "key:webhookUrl", comma-separated (dev). Empty list = open dev mode. */
  apiKeys: string[];
  rateLimitPerMinute?: number;
  fetchImpl?: typeof fetch;
}

const IntentBody = z.object({
  prompt: z.string().min(1).max(8000),
  budgetAp3x: z.number().positive(),
  mode: TaskModeSchema.default("confirm"),
  plan: z.unknown().optional(),
});

const ApproveBody = z.object({ stepId: z.string().optional() }).default({});

interface KeyEntry {
  hash: Buffer;
  webhookUrl: string | null;
  hits: number[];
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const limit = deps.rateLimitPerMinute ?? 60;
  const keys: KeyEntry[] = deps.apiKeys.map((entry) => {
    const [key, webhookUrl] = entry.split(/:(.+)/);
    return { hash: sha256buf(key ?? ""), webhookUrl: webhookUrl ?? null, hits: [] };
  });

  const authenticate = (req: FastifyRequest, reply: FastifyReply): KeyEntry | null | "denied" => {
    if (keys.length === 0) return null; // open dev mode
    const presented = (req.headers["x-api-key"] ?? "") as string;
    const presentedHash = sha256buf(presented);
    const entry = keys.find((k) => k.hash.length === presentedHash.length && timingSafeEqual(k.hash, presentedHash));
    if (!entry) {
      void reply.code(401).send({ error: "invalid api key" });
      return "denied";
    }
    const now = Date.now();
    entry.hits = entry.hits.filter((t) => t > now - 60_000);
    if (entry.hits.length >= limit) {
      void reply.code(429).send({ error: "rate limit exceeded" });
      return "denied";
    }
    entry.hits.push(now);
    return entry;
  };

  app.get("/health", async () => ({ ok: true, service: "conductor" }));

  app.post("/v1/intents", async (req, reply) => {
    const auth = authenticate(req, reply);
    if (auth === "denied") return;
    const body = IntentBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    try {
      const task = await deps.orchestrator.submitIntent({ ...body.data, userId: undefined });
      if (auth?.webhookUrl) watchForCompletion(deps, task.taskId, auth.webhookUrl);
      return reply.code(202).send({ taskId: task.taskId });
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  app.get("/v1/tasks/:id", async (req, reply) => {
    if (authenticate(req, reply) === "denied") return;
    const { id } = req.params as { id: string };
    const task = await deps.store.getTask(id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    const steps = await deps.store.getSteps(id);
    const payments = await deps.store.listPayments(id);
    return { task, steps, payments };
  });

  app.get("/v1/tasks/:id/events", async (req, reply) => {
    if (authenticate(req, reply) === "denied") return;
    const { id } = req.params as { id: string };
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    let lastId: string | null = null;
    let closed = false;
    req.raw.on("close", () => {
      closed = true;
    });
    while (!closed) {
      const events = (await deps.store.eventsSince(lastId)).filter(
        (e) => (e.payload as { taskId?: string } | null)?.taskId === id,
      );
      for (const event of events) {
        reply.raw.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
      }
      const all = await deps.store.eventsSince(lastId);
      if (all.length > 0) lastId = all[all.length - 1]!.id;
      const task = await deps.store.getTask(id);
      if (task && (task.status === "complete" || task.status === "failed")) {
        reply.raw.write(`event: done\ndata: ${JSON.stringify({ status: task.status })}\n\n`);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    reply.raw.end();
  });

  app.post("/v1/tasks/:id/approve", async (req, reply) => {
    if (authenticate(req, reply) === "denied") return;
    const { id } = req.params as { id: string };
    const body = ApproveBody.parse(req.body ?? {});
    try {
      await deps.orchestrator.approveTask(id, body.stepId);
      return { ok: true };
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  app.post("/v1/tasks/:id/cancel", async (req, reply) => {
    if (authenticate(req, reply) === "denied") return;
    const { id } = req.params as { id: string };
    try {
      await deps.orchestrator.cancelTask(id);
      return { ok: true };
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  app.get("/v1/agents", async (req, reply) => {
    if (authenticate(req, reply) === "denied") return;
    const { capability } = req.query as { capability?: string };
    const resolved = await deps.resolveAgents(capability);
    return resolved.map((r) => ({ ...r.profile, source: r.source, status: r.row.status }));
  });

  return app;
}

function watchForCompletion(deps: ServerDeps, taskId: string, webhookUrl: string): void {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const poll = async () => {
    for (let i = 0; i < 720; i++) {
      const task = await deps.store.getTask(taskId);
      if (task && (task.status === "complete" || task.status === "failed")) {
        await fetchImpl(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ taskId, status: task.status, anchorTx: task.anchorTx, totalFeesAp3x: task.totalFeesAp3x }),
        }).catch(() => undefined);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  };
  void poll();
}

function sha256buf(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}
