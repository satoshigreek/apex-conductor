-- SPEC §3 — data model v1
CREATE TABLE IF NOT EXISTS agents (
  agent_id text PRIMARY KEY,
  name text,
  capabilities text[] NOT NULL DEFAULT '{}',
  endpoint_type text,
  endpoint_url text,
  pricing_model text,
  price_ap3x numeric,
  stake_ap3x numeric,
  owner_pkh text,
  registered_tx text,
  reputation numeric NOT NULL DEFAULT 0.5,
  rep_tasks int NOT NULL DEFAULT 0,
  rep_disputes int NOT NULL DEFAULT 0,
  last_heartbeat timestamptz,
  status text NOT NULL DEFAULT 'active',          -- active|stale|cooldown
  raw_datum jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_manifests (      -- BLOCKER-3 fallback (SPEC §4.1)
  agent_id text PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
  endpoint_type text NOT NULL,
  endpoint_url text NOT NULL,
  pricing_model text NOT NULL,
  price_ap3x numeric NOT NULL,
  signature text NOT NULL,
  public_key text NOT NULL,
  verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id uuid PRIMARY KEY,
  user_id text,
  intent text NOT NULL,
  mode text NOT NULL DEFAULT 'confirm',           -- auto|confirm
  budget_ap3x numeric NOT NULL,
  status text NOT NULL,                           -- planning|awaiting_approval|running|verifying|complete|failed|refunded
  plan jsonb,
  total_fees_ap3x numeric NOT NULL DEFAULT 0,
  anchor_tx text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS steps (
  step_id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  idx int NOT NULL,
  kind text NOT NULL,                             -- agent_call|chain_action|human_checkpoint|aggregate
  capability text,
  agent_id text,
  budget_cap_ap3x numeric,
  status text NOT NULL DEFAULT 'pending',
  attempts int NOT NULL DEFAULT 0,
  input jsonb,
  output jsonb,
  verification jsonb,
  fee_paid_ap3x numeric,
  payment_tx text,
  started_at timestamptz,
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS payments (
  payment_id uuid PRIMARY KEY,
  task_id uuid REFERENCES tasks(task_id),
  step_id uuid REFERENCES steps(step_id),
  kind text NOT NULL,                             -- escrow_lock|release|refund|protocol_fee|x402
  amount numeric NOT NULL,
  asset text NOT NULL,
  tx_hash text,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gas_accounts (
  vector_address text PRIMARY KEY,
  balance_ap3x numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gas_events (
  id uuid PRIMARY KEY,
  vector_address text NOT NULL REFERENCES gas_accounts(vector_address),
  delta numeric NOT NULL,
  source text NOT NULL,                           -- refuel_swap|x402|spend
  ref jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (               -- append-only audit
  id uuid PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  type text NOT NULL,
  payload jsonb
);

CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_agents_capabilities ON agents USING gin(capabilities);
CREATE INDEX IF NOT EXISTS idx_steps_task ON steps(task_id, idx);
CREATE INDEX IF NOT EXISTS idx_payments_task ON payments(task_id);
CREATE INDEX IF NOT EXISTS idx_gas_events_addr ON gas_events(vector_address, created_at);
