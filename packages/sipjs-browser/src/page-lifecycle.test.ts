import { describe, expect, it, vi } from 'vitest';
import { observePageLifecycle, type PageLifecycleTarget } from './page-lifecycle.js';

class FakeDocument implements PageLifecycleTarget {
  public visibilityState: DocumentVisibilityState = 'visible';
  public wasDiscarded = false;
  readonly #listeners = new Map<string, Set<EventListener>>();

  public addEventListener(type: string, listener: EventListener): void {
    const listeners = this.#listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: EventListener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  public emit(type: string): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(new Event(type));
    }
  }
}

describe('observePageLifecycle', () => {
  it('does not change signaling while hidden and checks connectivity on resume', () => {
    const document = new FakeDocument();
    const resume = vi.fn();
    const unsubscribe = observePageLifecycle({ document, resume });

    document.visibilityState = 'hidden';
    document.emit('visibilitychange');
    expect(resume).not.toHaveBeenCalled();

    document.visibilityState = 'visible';
    document.emit('visibilitychange');
    document.emit('pageshow');
    document.emit('resume');
    expect(resume).toHaveBeenCalledTimes(3);

    unsubscribe();
    document.emit('resume');
    expect(resume).toHaveBeenCalledTimes(3);
  });
});
