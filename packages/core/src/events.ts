import type {
  CallDirection,
  CallEndReason,
  CallNetworkQuality,
  CallSnapshot,
  AudioDeviceSnapshot,
  IncomingCallRejectedReason,
  RegistrationState,
  TransportState,
  TransferState,
} from './domain.js';
import type { ErrorContext, MiCallErrorCode } from './errors.js';

export interface TransportStateChangedEvent {
  readonly previousState: TransportState;
  readonly state: TransportState;
  readonly timestamp: number;
}

export interface RegistrationStateChangedEvent {
  readonly previousState: RegistrationState;
  readonly state: RegistrationState;
  readonly timestamp: number;
}

export interface IncomingCallEvent {
  readonly callId: string;
  readonly direction: 'incoming';
  readonly timestamp: number;
  readonly snapshot: CallSnapshot;
}

export interface IncomingCallRejectedEvent {
  readonly callId: string;
  readonly reason: IncomingCallRejectedReason;
  readonly timestamp: number;
}

export interface CallStateChangedEvent {
  readonly callId: string;
  readonly direction: CallDirection;
  readonly previousState: CallSnapshot['state'];
  readonly state: CallSnapshot['state'];
  readonly timestamp: number;
  readonly snapshot: CallSnapshot;
}

export interface CallEndedEvent {
  readonly callId: string;
  readonly direction: CallDirection;
  readonly reason: CallEndReason;
  readonly sipStatusCode?: number;
  readonly timestamp: number;
  readonly snapshot: CallSnapshot;
}

export interface MiCallErrorEvent {
  readonly code: MiCallErrorCode;
  readonly message: string;
  readonly recoverable: boolean;
  readonly callId?: string;
  readonly timestamp: number;
  readonly context: ErrorContext;
}

export interface AudioUnlockRequiredEvent {
  readonly callId: string;
  readonly timestamp: number;
}

export interface MediaDevicesChangedEvent {
  readonly devices: readonly AudioDeviceSnapshot[];
  readonly selectedAudioInputId?: string;
  readonly selectedCallAudioOutputId?: string;
  readonly selectedRingtoneOutputId?: string;
  readonly timestamp: number;
}

export interface TransferStateChangedEvent {
  readonly callId: string;
  readonly destination: string;
  readonly state: TransferState;
  readonly timestamp: number;
  readonly snapshot: CallSnapshot;
}

export interface CallNetworkMetricsChangedEvent {
  readonly callId: string;
  readonly networkQuality: CallNetworkQuality;
  readonly networkKilobytesPerSecond?: number;
  readonly timestamp: number;
  readonly snapshot: CallSnapshot;
}

export interface MiCallEventMap {
  readonly transportStateChanged: TransportStateChangedEvent;
  readonly registrationStateChanged: RegistrationStateChangedEvent;
  readonly incomingCall: IncomingCallEvent;
  readonly incomingCallRejected: IncomingCallRejectedEvent;
  readonly callStateChanged: CallStateChangedEvent;
  readonly callEnded: CallEndedEvent;
  readonly error: MiCallErrorEvent;
  readonly audioUnlockRequired: AudioUnlockRequiredEvent;
  readonly mediaDevicesChanged: MediaDevicesChangedEvent;
  readonly transferStateChanged: TransferStateChangedEvent;
  readonly callNetworkMetricsChanged: CallNetworkMetricsChangedEvent;
}

export type MiCallEventName = keyof MiCallEventMap;
export type Unsubscribe = () => void;

export class TypedEventEmitter<EventMap extends object> {
  readonly #listeners = new Map<keyof EventMap, Set<(payload: never) => void>>();
  readonly #onListenerError: ((error: unknown) => void) | undefined;

  public constructor(onListenerError?: (error: unknown) => void) {
    this.#onListenerError = onListenerError;
  }

  public on<EventName extends keyof EventMap>(
    eventName: EventName,
    listener: (payload: EventMap[EventName]) => void,
  ): Unsubscribe {
    const listeners = this.#listeners.get(eventName) ?? new Set<(payload: never) => void>();
    listeners.add(listener as (payload: never) => void);
    this.#listeners.set(eventName, listeners);

    return (): void => {
      listeners.delete(listener as (payload: never) => void);
      if (listeners.size === 0) {
        this.#listeners.delete(eventName);
      }
    };
  }

  public emit<EventName extends keyof EventMap>(
    eventName: EventName,
    payload: EventMap[EventName],
  ): void {
    const listeners = this.#listeners.get(eventName);
    if (listeners === undefined) {
      return;
    }

    for (const listener of [...listeners]) {
      try {
        listener(payload as never);
      } catch (error) {
        this.#onListenerError?.(error);
        continue;
      }
    }
  }

  public clear(): void {
    this.#listeners.clear();
  }
}
