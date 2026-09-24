import type { LoggerPort } from '@micall/core';

export interface PageLifecycleTarget {
  readonly visibilityState: DocumentVisibilityState;
  readonly wasDiscarded?: boolean;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export interface PageLifecycleOptions {
  readonly document: PageLifecycleTarget;
  readonly resume: () => void;
  readonly logger?: LoggerPort;
}

export function observePageLifecycle(options: PageLifecycleOptions): () => void {
  const handleVisibility = (): void => {
    if (options.document.visibilityState === 'visible') {
      options.logger?.log('debug', 'Page became visible; checking SIP connectivity.');
      options.resume();
      return;
    }
    options.logger?.log('debug', 'Page became hidden; SIP lifecycle remains unchanged.');
  };
  const handlePageHide = (): void => {
    options.logger?.log('debug', 'Page entered pagehide; SIP lifecycle remains unchanged.');
  };
  const handlePageShow = (): void => {
    if (options.document.wasDiscarded === true) {
      options.logger?.log('warn', 'Page was discarded; previous SIP sessions cannot be restored.');
    }
    options.resume();
  };
  const handleFreeze = (): void => {
    options.logger?.log('debug', 'Page freeze detected; incoming calls are not guaranteed.');
  };
  const handleResume = (): void => {
    options.resume();
  };

  const listeners: readonly (readonly [string, EventListener])[] = [
    ['visibilitychange', handleVisibility],
    ['pagehide', handlePageHide],
    ['pageshow', handlePageShow],
    ['freeze', handleFreeze],
    ['resume', handleResume],
  ];
  for (const [name, listener] of listeners) {
    options.document.addEventListener(name, listener);
  }

  return (): void => {
    for (const [name, listener] of listeners) {
      options.document.removeEventListener(name, listener);
    }
  };
}
