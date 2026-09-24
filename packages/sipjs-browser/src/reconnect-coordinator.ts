import type { LoggerPort, RandomSource, Scheduler } from '@micall/core';

export interface ReconnectCoordinatorOptions {
  readonly reconnect: () => Promise<void>;
  readonly scheduler: Scheduler;
  readonly random: RandomSource;
  readonly logger?: LoggerPort;
  readonly baseDelayMs?: number;
  readonly maximumDelayMs?: number;
  readonly stableResetMs?: number;
}

export class ReconnectCoordinator {
  readonly #options: Required<
    Pick<ReconnectCoordinatorOptions, 'baseDelayMs' | 'maximumDelayMs' | 'stableResetMs'>
  > &
    Omit<ReconnectCoordinatorOptions, 'baseDelayMs' | 'maximumDelayMs' | 'stableResetMs'>;
  #retryHandle: unknown;
  #stableHandle: unknown;
  #attempt = 0;
  #running = false;
  #connected = false;
  #inFlight = false;

  public constructor(options: ReconnectCoordinatorOptions) {
    this.#options = {
      ...options,
      baseDelayMs: options.baseDelayMs ?? 500,
      maximumDelayMs: options.maximumDelayMs ?? 30_000,
      stableResetMs: options.stableResetMs ?? 30_000,
    };
  }

  public start(): void {
    this.#running = true;
  }

  public connected(): void {
    this.#connected = true;
    this.#clearRetry();
    this.#clearStableReset();
    this.#stableHandle = this.#options.scheduler.set(this.#options.stableResetMs, () => {
      this.#attempt = 0;
      this.#stableHandle = undefined;
    });
  }

  public disconnected(): void {
    this.#connected = false;
    this.#clearStableReset();
    this.#scheduleRetry();
  }

  public resume(): void {
    if (this.#running && !this.#connected) {
      this.#scheduleRetry();
    }
  }

  public stop(): void {
    this.#running = false;
    this.#connected = false;
    this.#attempt = 0;
    this.#clearRetry();
    this.#clearStableReset();
  }

  #scheduleRetry(): void {
    if (!this.#running || this.#connected || this.#retryHandle !== undefined || this.#inFlight) {
      return;
    }

    const ceiling = Math.min(
      this.#options.maximumDelayMs,
      this.#options.baseDelayMs * 2 ** this.#attempt,
    );
    const delay = Math.floor(Math.max(0, Math.min(1, this.#options.random.next())) * ceiling);
    this.#retryHandle = this.#options.scheduler.set(delay, () => {
      this.#retryHandle = undefined;
      void this.#runAttempt();
    });
  }

  async #runAttempt(): Promise<void> {
    if (!this.#running || this.#connected || this.#inFlight) {
      return;
    }
    this.#inFlight = true;
    this.#attempt += 1;
    try {
      await this.#options.reconnect();
    } catch (error) {
      this.#options.logger?.log('warn', 'SIP transport reconnect attempt failed.', {
        attempt: this.#attempt,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    } finally {
      this.#inFlight = false;
      this.#scheduleRetry();
    }
  }

  #clearRetry(): void {
    if (this.#retryHandle !== undefined) {
      this.#options.scheduler.clear(this.#retryHandle);
      this.#retryHandle = undefined;
    }
  }

  #clearStableReset(): void {
    if (this.#stableHandle !== undefined) {
      this.#options.scheduler.clear(this.#stableHandle);
      this.#stableHandle = undefined;
    }
  }
}
