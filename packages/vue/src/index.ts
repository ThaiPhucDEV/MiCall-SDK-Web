import { onScopeDispose, readonly, shallowRef, type ShallowRef } from 'vue';
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

export interface MiCallVueBinding {
  readonly client: MiCallConsumerClient;
  readonly snapshot: Readonly<ShallowRef<MiCallPublicSnapshot>>;
  readonly stop: Unsubscribe;
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

export function useMiCall(client: MiCallConsumerClient): MiCallVueBinding {
  const mutableSnapshot = shallowRef(client.getSnapshot());
  const stop = subscribeToMiCallSnapshot(client, () => {
    mutableSnapshot.value = client.getSnapshot();
  });
  const snapshot = readonly(mutableSnapshot) as Readonly<ShallowRef<MiCallPublicSnapshot>>;
  onScopeDispose(stop);
  return Object.freeze({
    client,
    snapshot,
    stop,
  });
}
