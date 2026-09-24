import type {
  AudioUnlockResult,
  CallSnapshot,
  MiCallCapabilities,
  RegistrationState,
  TransportState,
} from './domain.js';
import type { MiCallEventMap, Unsubscribe } from './events.js';
import type { OutgoingCallRequest } from './ports.js';

export interface MiCallPublicSnapshot {
  readonly transportState: TransportState;
  readonly registrationState: RegistrationState;
  readonly calls: readonly CallSnapshot[];
}

export interface MiCallConsumerClient {
  on<EventName extends keyof MiCallEventMap>(
    eventName: EventName,
    listener: (payload: MiCallEventMap[EventName]) => void,
  ): Unsubscribe;
  getSnapshot(): MiCallPublicSnapshot;
  makeCall(
    destination: string,
    options?: Omit<OutgoingCallRequest, 'destination'>,
  ): Promise<CallSnapshot>;
  answerCall(callId: string): Promise<void>;
  rejectCall(callId: string): Promise<void>;
  hangupCall(callId: string): Promise<void>;
  setMuted(callId: string, muted: boolean): Promise<void>;
  setHold(callId: string, held: boolean): Promise<void>;
  sendDtmf(callId: string, tones: string): Promise<void>;
  blindTransfer(callId: string, destination: string): Promise<void>;
  selectAudioInput(deviceId: string): Promise<void>;
  selectCallAudioOutput(deviceId: string): Promise<void>;
  selectRingtoneOutput(deviceId: string): Promise<void>;
  unlockAudio(): Promise<AudioUnlockResult>;
  getCapabilities(): MiCallCapabilities;
}
