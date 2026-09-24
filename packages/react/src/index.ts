import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type {
  MiCallConsumerClient,
  MiCallEventMap,
  MiCallPublicSnapshot,
  Unsubscribe,
} from '@micall/core';

const SNAPSHOT_EVENTS = [
  'transportStateChanged',
  'registrationStateChanged',
  'incomingCall',
  'callStateChanged',
  'callNetworkMetricsChanged',
  'callEnded',
] as const satisfies readonly (keyof MiCallEventMap)[];

export interface MiCallReactBinding {
  readonly client: MiCallConsumerClient;
  readonly snapshot: MiCallPublicSnapshot;
}

export function subscribeToMiCallSnapshot(
  client: MiCallConsumerClient,
  onStoreChange: () => void,
): Unsubscribe {
  const subscriptions = SNAPSHOT_EVENTS.map((eventName) => client.on(eventName, onStoreChange));
  return (): void => {
    for (const unsubscribe of subscriptions) {
      unsubscribe();
    }
  };
}

export function useMiCallSnapshot(client: MiCallConsumerClient): MiCallPublicSnapshot {
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeToMiCallSnapshot(client, onStoreChange),
    [client],
  );
  const getSnapshot = useCallback(() => client.getSnapshot(), [client]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useMiCall(client: MiCallConsumerClient): MiCallReactBinding {
  const snapshot = useMiCallSnapshot(client);
  return useMemo(() => Object.freeze({ client, snapshot }), [client, snapshot]);
}
