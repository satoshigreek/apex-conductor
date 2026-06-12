import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { Orchestrator } from "./orchestrator.js";
import type { TaskStore } from "./taskstore.js";

/**
 * SPEC §5.2 MCP surface — a single tool `conduct(intent, budgetAp3x)` over SSE in the
 * same service, so Claude Desktop / any MCP client can drive Conductor.
 */
export function registerMcp(app: FastifyInstance, orchestrator: Orchestrator, store: TaskStore): void {
  const server = new McpServer({ name: "apex-conductor", version: "0.1.0" });

  server.tool(
    "conduct",
    "Orchestrate a task on the Vector agent network: plans a DAG of specialist agents, executes with verification and AP3X payments, anchors an audit summary on-chain. Returns the task result or a checkpoint request.",
    { intent: z.string().min(1), budgetAp3x: z.number().positive() },
    async ({ intent, budgetAp3x }) => {
      const task = await orchestrator.submitIntent({ prompt: intent, budgetAp3x, mode: "auto" });
      // wait for terminal state or checkpoint (bounded)
      const deadline = Date.now() + 180_000;
      let status = "planning";
      while (Date.now() < deadline) {
        const current = await store.getTask(task.taskId);
        status = current?.status ?? status;
        if (status === "complete" || status === "failed" || status === "awaiting_approval") break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      const final = await store.getTask(task.taskId);
      const steps = await store.getSteps(task.taskId);
      const aggregate = steps.find((s) => s.kind === "aggregate");
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              taskId: task.taskId,
              status: final?.status,
              anchorTx: final?.anchorTx,
              totalFeesAp3x: final?.totalFeesAp3x,
              error: final?.error,
              result: aggregate?.output ?? null,
            }),
          },
        ],
      };
    },
  );

  const transports = new Map<string, SSEServerTransport>();

  app.get("/mcp/sse", async (req, reply) => {
    const transport = new SSEServerTransport("/mcp/messages", reply.raw);
    transports.set(transport.sessionId, transport);
    reply.raw.on("close", () => transports.delete(transport.sessionId));
    await server.connect(transport);
  });

  app.post("/mcp/messages", async (req, reply) => {
    const sessionId = (req.query as { sessionId?: string }).sessionId ?? "";
    const transport = transports.get(sessionId);
    if (!transport) return reply.code(400).send({ error: "unknown sessionId" });
    await transport.handlePostMessage(req.raw, reply.raw, req.body);
  });
}
