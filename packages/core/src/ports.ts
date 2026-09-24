import type {
  CallDirection,
  CallEndReason,
  CallNetworkQuality,
  CallState,
  AudioDeviceSnapshot,
  AudioUnlockResult,
  MiCallCapabilities,
  RegistrationState,
  TransportState,
  TransferState,
} from './domain.js';
import type { ErrorContext, MiCallErrorCode } from './errors.js';
import type { LogContext, LogLevel } from './logging.js';

export interface Clock {
  now(): number;
}

export interface IdGenerator {
  next(): string;
}

export interface Scheduler {
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}

export interface RandomSource {
  next(): number;
}

export interface LoggerPort {
  log(level: LogLevel, message: string, context?: LogContext): void;
}

export interface MediaPort {
  ensureMicrophoneAccess(): Promise<void>;
  release(callId: string): Promise<void>;
}

export interface AudioPort {
  startRingtone(callId: string): Promise<void>;
  stopRingtone(callId: string): Promise<void>;
  unlock(): Promise<void>;
}

export type SignalingEvent =
  | { readonly type: 'transport-state'; readonly state: TransportState }
  | { readonly type: 'registration-state'; readonly state: RegistrationState }
  | {
      readonly type: 'incoming-call';
      readonly callId: string;
      readonly remoteIdentity: string;
      readonly remoteAddress?: string;
      readonly metadata: Readonly<Record<string, string>>;
    }
  | {
      readonly type: 'call-state';
      readonly callId: string;
      readonly state: Exclude<CallState, 'incoming-ringing' | 'outgoing-dialing' | 'ended'>;
    }
  | {
      readonly type: 'call-ended';
      readonly callId: string;
      readonly reason: CallEndReason;
      readonly sipStatusCode?: number;
    }
  | {
      readonly type: 'call-properties';
      readonly callId: string;
      readonly muted?: boolean;
      readonly localHold?: boolean;
      readonly remoteHold?: boolean;
      readonly networkQuality?: CallNetworkQuality;
      readonly networkKilobytesPerSecond?: number;
    }
  | {
      readonly type: 'audio-unlock-required';
      readonly callId: string;
    }
  | {
      readonly type: 'media-devices';
      readonly devices: readonly AudioDeviceSnapshot[];
      readonly selectedAudioInputId?: string;
      readonly selectedCallAudioOutputId?: string;
      readonly selectedRingtoneOutputId?: string;
    }
  | {
      readonly type: 'transfer-state';
      readonly callId: string;
      readonly destination: string;
      readonly state: TransferState;
    }
  | {
      readonly type: 'error';
      readonly code: MiCallErrorCode;
      readonly message: string;
      readonly recoverable: boolean;
      readonly callId?: string;
      readonly context?: ErrorContext;
    };

export interface SignalingPort {
  subscribe(listener: (event: SignalingEvent) => void): () => void;
  start(): Promise<void>;
  register(): Promise<void>;
  unregister(): Promise<void>;
  stop(): Promise<void>;
  destroy(): Promise<void>;
  makeCall(callId: string, destination: string): Promise<void>;
  answerCall(callId: string): Promise<void>;
  rejectCall(callId: string, statusCode: number): Promise<void>;
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

export interface OutgoingCallRequest {
  readonly destination: string;
  readonly remoteIdentity?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface CoreDependencies {
  readonly signaling: SignalingPort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger?: LoggerPort;
}

export interface SignalingCallDescriptor {
  readonly callId: string;
  readonly direction: CallDirection;
}
