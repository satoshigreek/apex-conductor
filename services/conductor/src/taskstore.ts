import { randomUUID } from "node:crypto";
import type { TaskMode, TaskPlan, TaskStatus } from "@apex/core";

/** SPEC §3 — tasks/steps/payments/events. Memory impl for dev/tests; Pg impl lands with infra. */
export interface TaskRecord {
  taskId: string;
  userId: string | null;
  intent: string;
  mode: TaskMode;
  budgetAp3x: number;
  status: TaskStatus;
  plan: TaskPlan | null;
  totalFeesAp3x: number;
  anchorTx: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StepRecord {
  stepId: string;
  taskId: string;
  idx: number;
  planStepId: string;
  kind: string;
  capability: string | null;
  agentId: string | null;
  budgetCapAp3x: number | null;
  status: "pending" | "running" | "awaiting_approval" | "complete" | "failed" | "skipped";
  attempts: number;
  input: unknown;
  output: unknown;
  verification: unknown;
  feePaidAp3x: number | null;
  paymentTx: string | null;
}

export interface PaymentRecord {
  paymentId: string;
  taskId: string;
  stepId: string | null;
  kind: "escrow_lock" | "release" | "refund" | "protocol_fee" | "x402";
  amount: number;
  asset: string;
  txHash: string | null;
  status: "pending" | "confirmed" | "failed";
  createdAt: Date;
}

export interface EventRecord {
  id: string;
  ts: Date;
  actor: string;
  type: string;
  payload: unknown;
}

export interface TaskStore {
  createTask(input: { intent: string; mode: TaskMode; budgetAp3x: number; userId?: string }): Promise<TaskRecord>;
  getTask(taskId: string): Promise<TaskRecord | null>;
  updateTask(taskId: string, patch: Partial<TaskRecord>): Promise<void>;
  listTasks(userId?: string): Promise<TaskRecord[]>;
  createSteps(taskId: string, steps: Omit<StepRecord, "stepId" | "taskId">[]): Promise<StepRecord[]>;
  getSteps(taskId: string): Promise<StepRecord[]>;
  updateStep(stepId: string, patch: Partial<StepRecord>): Promise<void>;
  recordPayment(p: Omit<PaymentRecord, "paymentId" | "createdAt">): Promise<PaymentRecord>;
  listPayments(taskId: string): Promise<PaymentRecord[]>;
  appendEvent(actor: string, type: string, payload: unknown): Promise<EventRecord>;
  eventsSince(afterId: string | null): Promise<EventRecord[]>;
  /** total confirmed AP3X released today across all tasks (daily cap) */
  spentToday(now?: Date): Promise<number>;
}

export class MemoryTaskStore implements TaskStore {
  tasks = new Map<string, TaskRecord>();
  steps = new Map<string, StepRecord>();
  payments: PaymentRecord[] = [];
  events: EventRecord[] = [];
  private eventCounter = 0;

  async createTask(input: { intent: string; mode: TaskMode; budgetAp3x: number; userId?: string }): Promise<TaskRecord> {
    const task: TaskRecord = {
      taskId: randomUUID(),
      userId: input.userId ?? null,
      intent: input.intent,
      mode: input.mode,
      budgetAp3x: input.budgetAp3x,
      status: "planning",
      plan: null,
      totalFeesAp3x: 0,
      anchorTx: null,
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.tasks.set(task.taskId, task);
    return task;
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    return this.tasks.get(taskId) ?? null;
  }

  async updateTask(taskId: string, patch: Partial<TaskRecord>): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    Object.assign(task, patch, { updatedAt: new Date() });
  }

  async listTasks(userId?: string): Promise<TaskRecord[]> {
    const all = [...this.tasks.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return userId ? all.filter((t) => t.userId === userId) : all;
  }

  async createSteps(taskId: string, steps: Omit<StepRecord, "stepId" | "taskId">[]): Promise<StepRecord[]> {
    return steps.map((s) => {
      const step: StepRecord = { ...s, stepId: randomUUID(), taskId };
      this.steps.set(step.stepId, step);
      return step;
    });
  }

  async getSteps(taskId: string): Promise<StepRecord[]> {
    return [...this.steps.values()].filter((s) => s.taskId === taskId).sort((a, b) => a.idx - b.idx);
  }

  async updateStep(stepId: string, patch: Partial<StepRecord>): Promise<void> {
    const step = this.steps.get(stepId);
    if (!step) throw new Error(`unknown step ${stepId}`);
    Object.assign(step, patch);
  }

  async recordPayment(p: Omit<PaymentRecord, "paymentId" | "createdAt">): Promise<PaymentRecord> {
    const payment: PaymentRecord = { ...p, paymentId: randomUUID(), createdAt: new Date() };
    this.payments.push(payment);
    return payment;
  }

  async listPayments(taskId: string): Promise<PaymentRecord[]> {
    return this.payments.filter((p) => p.taskId === taskId);
  }

  async appendEvent(actor: string, type: string, payload: unknown): Promise<EventRecord> {
    const event: EventRecord = { id: String(++this.eventCounter), ts: new Date(), actor, type, payload };
    this.events.push(event);
    return event;
  }

  async eventsSince(afterId: string | null): Promise<EventRecord[]> {
    if (afterId === null) return [...this.events];
    const after = Number(afterId);
    return this.events.filter((e) => Number(e.id) > after);
  }

  async spentToday(now = new Date()): Promise<number> {
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);
    return this.payments
      .filter((p) => p.kind === "release" && p.status === "confirmed" && p.createdAt >= dayStart)
      .reduce((sum, p) => sum + p.amount, 0);
  }
}

// TODO(M2-infra): PgTaskStore over the SPEC §3 tables; MemoryTaskStore is the dev default.
