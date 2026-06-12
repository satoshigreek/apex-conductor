import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { ChainToolRunner } from "./executor.js";

/**
 * SPEC §1.5/§5.2 — Conductor wraps the official Vector MCP server (Apex-Fusion/mcp-server,
 * 18+ tools with its own rate limiter, spend limits, audit log, dry-run); we do NOT
 * reimplement chain tools. Enabled via MCP_SERVER_URL; StubChainTools otherwise.
 *
 * Value-moving classification is conservative: anything matching the pattern OR listed
 * explicitly requires dry-run + checkpoint policy in the executor.
 */
const VALUE_MOVING_EXPLICIT = new Set([
  "send_ada",
  "send_ap3x",
  "send_tokens",
  "register_agent",
  "deregister_agent",
  "transfer_agent",
  "deploy_contract",
  "interact_contract",
]);
const VALUE_MOVING_PATTERN = /send|pay|transfer|stake|swap|submit|deploy|register|mint|burn/i;

export class McpChainTools implements ChainToolRunner {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(
    private serverUrl: string,
    private log?: (msg: string) => void,
  ) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    this.connecting ??= (async () => {
      const client = new Client({ name: "apex-conductor", version: "0.1.0" });
      const transport = new SSEClientTransport(new URL(this.serverUrl));
      await client.connect(transport);
      const tools = await client.listTools();
      this.log?.(`MCP chain tools connected: ${tools.tools.length} tools (${tools.tools.slice(0, 6).map((t) => t.name).join(", ")}…)`);
      this.client = client;
      return client;
    })();
    return this.connecting;
  }

  async run(tool: string, args: Record<string, unknown>, opts: { dryRun: boolean }): Promise<unknown> {
    const client = await this.connect();
    // the Vector MCP server supports dry-run natively; pass it through
    const result = await client.callTool({ name: tool, arguments: { ...args, ...(opts.dryRun ? { dryRun: true } : {}) } });
    if (result.isError) {
      const text = Array.isArray(result.content)
        ? result.content.map((c) => (c as { text?: string }).text ?? "").join(" ")
        : String(result.content);
      throw new Error(`mcp tool ${tool} failed: ${text.slice(0, 300)}`);
    }
    const content = Array.isArray(result.content) ? result.content : [];
    const texts = content.map((c) => (c as { text?: string }).text).filter((t): t is string => typeof t === "string");
    if (texts.length === 1) {
      try {
        return JSON.parse(texts[0]!);
      } catch {
        return { text: texts[0] };
      }
    }
    return { content };
  }

  isValueMoving(tool: string): boolean {
    return VALUE_MOVING_EXPLICIT.has(tool) || VALUE_MOVING_PATTERN.test(tool);
  }

  movesAmountAp3x(_tool: string, args: Record<string, unknown>): number {
    const direct = args.amountAp3x ?? args.ada ?? args.amount;
    if (typeof direct === "number") return direct;
    const lovelace = args.lovelace ?? args.amountLovelace;
    if (typeof lovelace === "number") return lovelace / 1_000_000;
    return 0;
  }

  async close(): Promise<void> {
    await this.client?.close();
  }
}
