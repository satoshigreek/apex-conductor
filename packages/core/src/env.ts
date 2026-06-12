import { z } from "zod";

/** SPEC §8 — every env var; zod at the boundary. Services call loadEnv(process.env). */
export const EnvSchema = z.object({
  VECTOR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  KOIOS_URL: z.string().url().default("https://v2.koios.vector.testnet.apexfusion.org"),
  OGMIOS_URL: z.string().url().default("https://ogmios.vector.testnet.apexfusion.org"),
  TXSUBMIT_URL: z.string().url().default("https://submit.vector.testnet.apexfusion.org/api/submit/tx"),
  REGISTRY_SCRIPT_ADDR: z.string().default("addr1wxlp5z3fztdpsp6ha57dvx6khw82kqvgcxwu8s8rjykjcqghprf42"),
  REGISTRY_POLICY: z.string().default("be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01"),
  BASE_RPC: z.string().url().default("https://mainnet.base.org"),
  USDC_ADDR: z.string().default("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
  BAP3X_ADDR: z.string().default("0x9208d82f121806a34a39bb90733b4c5c54f3993e"),
  AERO_ROUTER: z.string().default("0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43"),
  AERO_FACTORY: z.string().default("0x420DD381b31aEf6683db6B902084cB0FFECe40Da"),

  VECTOR_HOT_WALLET_MNEMONIC: z.string().optional(),
  BASE_HOT_WALLET_PK: z.string().optional(),
  PROTOCOL_TREASURY_ADDR: z.string().optional(),
  REFUEL_PAYTO: z.string().optional(),

  LLM_PROVIDER: z.enum(["venice", "anthropic", "openai"]).default("anthropic"),
  PLANNER_MODEL: z.string().default("claude-fable-5"),
  WORKER_MODEL: z.string().default("claude-haiku-4-5-20251001"),
  VENICE_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),

  CHECKPOINT_AP3X: z.coerce.number().default(50),
  PER_TASK_CAP_AP3X: z.coerce.number().default(200),
  PER_SESSION_CAP_AP3X: z.coerce.number().default(500),
  DAILY_CAP_AP3X: z.coerce.number().default(2000),
  ROUTER_MIN_STAKE_AP3X: z.coerce.number().default(500),
  PROTOCOL_FEE_BPS: z.coerce.number().default(250),

  BRIDGE_MODE: z.enum(["handoff", "api", "oft"]).default("handoff"),
  SKYLINE_API: z.string().optional(),
  REACTOR_API: z.string().optional(),
  X402_FACILITATOR_URL: z.string().url().default("https://x402.org/facilitator"),
  REFUEL_LIVE: z
    .string()
    .default("false")
    .transform((v) => v === "true"),

  /** DEV ONLY — route to agents whose manifest signature is not yet verified (never in prod) */
  ALLOW_UNVERIFIED_MANIFESTS: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  DATABASE_URL: z.string().default("memory://"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  QUEUE_DRIVER: z.enum(["bullmq", "memory"]).default("memory"),
  VERIFICATION_API: z.string().optional(),

  CONDUCTOR_PORT: z.coerce.number().default(4000),
  INDEXER_PORT: z.coerce.number().default(4100),
  REFUEL_PORT: z.coerce.number().default(4200),
});
export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}
