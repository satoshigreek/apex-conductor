"use client";

import { useEffect, useState } from "react";
import { EXPLORER_TX, getTask, type TaskView } from "@/lib/api";

/**
 * SPEC §5.5 `/tasks` — history with explorer deep-links.
 * v1 keeps recently watched task ids in localStorage (the API lists per-key tasks in M4's operator console).
 */
export default function TasksPage() {
  const [tasks, setTasks] = useState<TaskView[]>([]);

  useEffect(() => {
    const ids: string[] = JSON.parse(localStorage.getItem("apex-task-ids") ?? "[]");
    void Promise.allSettled(ids.map((id) => getTask(id))).then((results) => {
      setTasks(results.filter((r): r is PromiseFulfilledResult<TaskView> => r.status === "fulfilled").map((r) => r.value));
    });
  }, []);

  return (
    <div>
      <p className="eyebrow mb-2">Anchored on Vector — every task leaves an audit trail</p>
      <h1 className="font-display text-4xl font-semibold uppercase tracking-wide mb-6">
        Task <span className="text-accent">history</span>
      </h1>

      {tasks.length === 0 ? (
        <div className="panel p-8 text-center font-mono text-xs text-ink-3">
          no tasks watched in this browser yet — conduct one from the home page
        </div>
      ) : (
        <div className="space-y-4">
          {tasks.map((view) => (
            <div key={view.task.taskId} className="panel p-5">
              <div className="flex items-center justify-between">
                <span className="font-body text-sm">{view.task.intent}</span>
                <span className="font-mono text-[10px] uppercase text-ink-3">{view.task.status}</span>
              </div>
              <div className="font-mono text-[10px] text-ink-3 mt-2 flex gap-6">
                <span>{view.task.taskId}</span>
                <span>{view.task.totalFeesAp3x} AP3X fees</span>
                {view.task.anchorTx && (
                  <a className="text-accent underline" href={EXPLORER_TX(view.task.anchorTx)} target="_blank" rel="noreferrer">
                    anchor ↗
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
