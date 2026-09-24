export type TransportState =
  'stopped' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export type RegistrationState =
  'unregistered' | 'registering' | 'registered' | 'unregistering' | 'failed';

export type CallDirection = 'incoming' | 'outgoing';

export type CallState =
  | 'incoming-ringing'
  | 'outgoing-dialing'
  | 'outgoing-ringing'
  | 'early-media'
  | 'establishing'
  | 'active'
  | 'terminating'
  | 'ended';

export type CallEndReason =
  | 'local-hangup'
  | 'remote-hangup'
  | 'local-cancel'
  | 'remote-cancel'
  | 'rejected'
  | 'busy'
  | 'declined'
  | 'no-answer'
  | 'failed'
  | 'transferred';

export type IncomingCallRejectedReason = 'busy' | 'destroyed';

export type TransferState = 'initiating' | 'completed' | 'failed';

export type CallNetworkQuality = 'unknown' | 'good' | 'fair' | 'poor';

export interface AudioDeviceSnapshot {
  readonly deviceId: string;
  readonly groupId: string;
  readonly kind: 'audioinput' | 'audiooutput';
  readonly label: string;
}

export interface AudioUnlockResult {
  readonly status: 'unlocked' | 'blocked' | 'not-configured';
}

export interface MiCallCapabilities {
  readonly audioOutputSelection: boolean;
  readonly rtpDtmf: boolean;
  readonly sipInfoDtmfFallback: boolean;
  readonly blindTransfer: boolean;
}

export interface CallSnapshot {
  readonly callId: string;
  readonly direction: CallDirection;
  readonly state: CallState;
  readonly muted: boolean;
  readonly localHold: boolean;
  readonly remoteHold: boolean;
  readonly remoteIdentity: string;
  readonly remoteAddress?: string;
  readonly networkQuality?: CallNetworkQuality;
  readonly networkKilobytesPerSecond?: number;
  readonly metadata: Readonly<Record<string, string>>;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly connectedAt?: number;
  readonly endedAt?: number;
  readonly endReason?: CallEndReason;
}

export function createCallSnapshot(input: CallSnapshot): CallSnapshot {
  return Object.freeze({
    ...input,
    metadata: Object.freeze({ ...input.metadata }),
  });
}

const allowedCallTransitions: Readonly<Record<CallState, ReadonlySet<CallState>>> = {
  'incoming-ringing': new Set(['establishing', 'terminating', 'ended']),
  'outgoing-dialing': new Set([
    'outgoing-ringing',
    'early-media',
    'establishing',
    'terminating',
    'ended',
  ]),
  'outgoing-ringing': new Set(['early-media', 'establishing', 'terminating', 'ended']),
  'early-media': new Set(['establishing', 'terminating', 'ended']),
  establishing: new Set(['active', 'terminating', 'ended']),
  active: new Set(['terminating', 'ended']),
  terminating: new Set(['ended']),
  ended: new Set(),
};

export function canTransitionCall(from: CallState, to: CallState): boolean {
  return from === to || allowedCallTransitions[from].has(to);
}
