import { z } from "zod";

export { CONDUCTOR_SYSTEM_PROMPT } from "./prompts/conductor.js";

/** SPEC §5.2 — provider-abstracted chat(). Planning uses PLANNER_MODEL, supervision WORKER_MODEL. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model: string;
  maxTokens?: number;
  temperature?: number;
  /** force strict-JSON output where the provider supports it */
  jsonMode?: boolean;
}

export interface ChatResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface LlmProvider {
  readonly name: string;
  chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult>;
}

export type ProviderName = "venice" | "anthropic" | "openai";

export interface ProviderConfig {
  provider: ProviderName;
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  constructor(private cfg: ProviderConfig) {}

  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
    const fetchImpl = this.cfg.fetchImpl ?? fetch;
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const rest = messages.filter((m) => m.role !== "system");
    const res = await fetchImpl(`${this.cfg.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.cfg.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 4096,
        temperature: opts.temperature ?? 0,
        ...(system ? { system } : {}),
        messages: rest.map((m) => ({ role: m.role, content: m.content })),
      }),
    });
    if (!res.ok) throw new Error(`anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as {
      content: Array<{ type: string; text?: string }>;
      usage?: { input_tokens: number; output_tokens: number };
    };
    const text = body.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    return { text, inputTokens: body.usage?.input_tokens, outputTokens: body.usage?.output_tokens };
  }
}

/** OpenAI-compatible chat/completions — used for both OpenAI and Venice. */
class OpenAiCompatProvider implements LlmProvider {
  constructor(
    readonly name: string,
    private cfg: ProviderConfig,
    private defaultBaseUrl: string,
  ) {}

  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
    const fetchImpl = this.cfg.fetchImpl ?? fetch;
    const res = await fetchImpl(`${this.cfg.baseUrl ?? this.defaultBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 4096,
        temperature: opts.temperature ?? 0,
        ...(opts.jsonMode ? { response_format: { type: "json_object" } } : {}),
        messages,
      }),
    });
    if (!res.ok) throw new Error(`${this.name} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    return {
      text: body.choices[0]?.message.content ?? "",
      inputTokens: body.usage?.prompt_tokens,
      outputTokens: body.usage?.completion_tokens,
    };
  }
}

export function createProvider(cfg: ProviderConfig): LlmProvider {
  switch (cfg.provider) {
    case "anthropic":
      return new AnthropicProvider(cfg);
    case "openai":
      return new OpenAiCompatProvider("openai", cfg, "https://api.openai.com/v1");
    case "venice":
      return new OpenAiCompatProvider("venice", cfg, "https://api.venice.ai/api/v1");
  }
}

/** Parse strict-JSON LLM output through a zod schema; strips markdown fences defensively. */
export function parseJsonOutput<T>(schema: z.ZodType<T>, raw: string): { ok: true; value: T } | { ok: false; error: string } {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence?.[1]) text = fence[1];
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    if (parsed.success) return { ok: true, value: parsed.data };
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message.slice(0, 200)}` };
  }
}
