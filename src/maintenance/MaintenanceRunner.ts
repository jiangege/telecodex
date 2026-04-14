import type { Logger } from "../runtime/logger.js";

export interface MaintenanceContext {
  logger: Logger;
}

export interface MaintenanceTask {
  readonly name: string;
  readonly intervalMs: number;
  readonly initialDelayMs?: number;
  readonly runOnStart?: boolean;
  run(context: MaintenanceContext): Promise<void>;
}

export class MaintenanceRunner {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private stopped = false;

  constructor(
    private readonly tasks: MaintenanceTask[],
    private readonly context: MaintenanceContext,
  ) {}

  start(): void {
    this.context.logger.info("starting maintenance runner", {
      tasks: this.tasks.map((task) => ({
        name: task.name,
        intervalMs: task.intervalMs,
        initialDelayMs: task.runOnStart ? 0 : (task.initialDelayMs ?? task.intervalMs),
        runOnStart: task.runOnStart ?? false,
      })),
    });

    for (const task of this.tasks) {
      this.schedule(task, task.runOnStart ? 0 : (task.initialDelayMs ?? task.intervalMs));
    }
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.context.logger.info("stopped maintenance runner");
  }

  private schedule(task: MaintenanceTask, delayMs: number): void {
    if (this.stopped) return;

    const timer = setTimeout(async () => {
      this.timers.delete(task.name);
      if (this.stopped) return;

      const startedAt = Date.now();
      try {
        await task.run(this.context);
        this.context.logger.info("maintenance task completed", {
          task: task.name,
          durationMs: Date.now() - startedAt,
        });
      } catch (error) {
        this.context.logger.error("maintenance task failed", {
          task: task.name,
          durationMs: Date.now() - startedAt,
          error,
        });
      } finally {
        this.schedule(task, task.intervalMs);
      }
    }, delayMs);

    this.timers.set(task.name, timer);
  }
}
