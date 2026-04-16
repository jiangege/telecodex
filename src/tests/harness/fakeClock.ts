import type { TelegramDeliveryRuntime } from "../../telegram/delivery.js";
import type { MessageBufferScheduler } from "../../telegram/messageBuffer.js";

interface ScheduledTask {
  id: number;
  at: number;
  callback: () => void;
  intervalMs: number | null;
}

export class FakeClock implements MessageBufferScheduler, TelegramDeliveryRuntime {
  private nowMs: number;
  private nextId = 1;
  private tasks = new Map<number, ScheduledTask>();
  private readonly cancelled = new Set<number>();

  constructor(startMs = Date.parse("2026-01-01T00:00:00.000Z")) {
    this.nowMs = startMs;
  }

  now = (): number => this.nowMs;

  setTimeout = (callback: () => void, ms: number): number => {
    return this.schedule(callback, Math.max(0, ms), null);
  };

  clearTimeout = (timer: unknown): void => {
    if (typeof timer !== "number") return;
    this.tasks.delete(timer);
    this.cancelled.add(timer);
  };

  setInterval = (callback: () => void, ms: number): number => {
    const intervalMs = Math.max(1, ms);
    return this.schedule(callback, intervalMs, intervalMs);
  };

  clearInterval = (timer: unknown): void => {
    this.clearTimeout(timer);
  };

  sleep = async (ms: number): Promise<void> => {
    await this.tick(ms);
  };

  async tick(ms: number): Promise<void> {
    const target = this.nowMs + Math.max(0, ms);
    for (;;) {
      const task = this.nextDueTask(target);
      if (!task) break;
      this.nowMs = task.at;
      this.tasks.delete(task.id);
      task.callback();
      if (task.intervalMs != null && !this.cancelled.has(task.id)) {
        this.tasks.set(task.id, {
          ...task,
          at: this.nowMs + task.intervalMs,
        });
      }
      this.cancelled.delete(task.id);
      await flushMicrotasks();
    }
    this.nowMs = target;
    await flushMicrotasks();
  }

  async flush(): Promise<void> {
    await this.tick(0);
  }

  private schedule(callback: () => void, delayMs: number, intervalMs: number | null): number {
    const id = this.nextId++;
    this.tasks.set(id, {
      id,
      at: this.nowMs + delayMs,
      callback,
      intervalMs,
    });
    this.cancelled.delete(id);
    return id;
  }

  private nextDueTask(target: number): ScheduledTask | null {
    let next: ScheduledTask | null = null;
    for (const task of this.tasks.values()) {
      if (task.at > target) continue;
      if (!next || task.at < next.at || (task.at === next.at && task.id < next.id)) {
        next = task;
      }
    }
    return next;
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
