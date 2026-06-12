import { Queue, Worker } from "bullmq";

/**
 * SPEC §5.2 — BullMQ queue for the DAG executor in v1 (Temporal is v2; do NOT add it).
 * QUEUE_DRIVER=memory executes inline (dev without Redis).
 */
export interface TaskQueue {
  enqueue(taskId: string): Promise<void>;
  close(): Promise<void>;
}

export class InlineQueue implements TaskQueue {
  constructor(
    private run: (taskId: string) => Promise<unknown>,
    private onError: (taskId: string, err: Error) => Promise<void>,
  ) {}

  async enqueue(taskId: string): Promise<void> {
    void this.run(taskId).catch((err) => this.onError(taskId, err as Error));
  }

  async close(): Promise<void> {}
}

export class BullMqTaskQueue implements TaskQueue {
  private queue: Queue;
  private worker: Worker;

  constructor(
    redisUrl: string,
    run: (taskId: string) => Promise<unknown>,
    onError: (taskId: string, err: Error) => Promise<void>,
  ) {
    const connection = { url: redisUrl };
    this.queue = new Queue("conductor-tasks", { connection });
    this.worker = new Worker(
      "conductor-tasks",
      async (job) => {
        const { taskId } = job.data as { taskId: string };
        try {
          await run(taskId);
        } catch (err) {
          await onError(taskId, err as Error);
          throw err;
        }
      },
      { connection },
    );
  }

  async enqueue(taskId: string): Promise<void> {
    await this.queue.add(`task:${taskId}`, { taskId }, { attempts: 1, removeOnComplete: 100, removeOnFail: 500 });
  }

  async close(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
  }
}
