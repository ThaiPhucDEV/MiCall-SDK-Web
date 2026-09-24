import { describe, expect, it, vi } from 'vitest';
import type { Scheduler } from '@micall/core';
import { ReconnectCoordinator } from './reconnect-coordinator.js';

class FakeScheduler implements Scheduler {
  readonly pending: Array<{ delayMs: number; callback: () => void; cancelled: boolean }> = [];

  public set(delayMs: number, callback: () => void): unknown {
    const task = { delayMs, callback, cancelled: false };
    this.pending.push(task);
    return task;
  }

  public clear(handle: unknown): void {
    (handle as { cancelled: boolean }).cancelled = true;
  }

  public runNext(): void {
    const task = this.pending.find((candidate) => !candidate.cancelled);
    if (task === undefined) {
      throw new Error('No pending timer.');
    }
    task.cancelled = true;
    task.callback();
  }
}

describe('ReconnectCoordinator', () => {
  it('uses full-jitter exponential backoff and only one retry timer', async () => {
    const scheduler = new FakeScheduler();
    const reconnect = vi.fn().mockRejectedValue(new Error('offline'));
    const coordinator = new ReconnectCoordinator({
      reconnect,
      scheduler,
      random: { next: () => 0.5 },
    });
    coordinator.start();

    coordinator.disconnected();
    coordinator.disconnected();
    expect(scheduler.pending.filter((task) => !task.cancelled)).toHaveLength(1);
    expect(scheduler.pending[0]?.delayMs).toBe(250);

    scheduler.runNext();
    await Promise.resolve();
    await Promise.resolve();
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(scheduler.pending.at(-1)?.delayMs).toBe(500);
  });

  it('cancels retries on stop', () => {
    const scheduler = new FakeScheduler();
    const coordinator = new ReconnectCoordinator({
      reconnect: async () => undefined,
      scheduler,
      random: { next: () => 0.5 },
    });
    coordinator.start();
    coordinator.disconnected();
    coordinator.stop();

    expect(scheduler.pending.every((task) => task.cancelled)).toBe(true);
  });
});
