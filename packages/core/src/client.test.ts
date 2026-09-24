import { describe, expect, it } from 'vitest';
import { MiCallClient } from './client.js';
import { MiCallError } from './errors.js';
import type { MiCallCapabilities } from './domain.js';
import type { SignalingEvent, SignalingPort } from './ports.js';

class FakeSignaling implements SignalingPort {
  readonly rejected: Array<{ callId: string; statusCode: number }> = [];
  readonly outgoing: Array<{ callId: string; destination: string }> = [];
  readonly muteChanges: Array<{ callId: string; muted: boolean }> = [];
  readonly holdChanges: Array<{ callId: string; held: boolean }> = [];
  readonly dtmfRequests: Array<{ callId: string; tones: string }> = [];
  readonly transfers: Array<{ callId: string; destination: string }> = [];
  hangupCount = 0;
  holdOperation: Promise<void> | undefined;
  holdError: Error | undefined;
  #listener: ((event: SignalingEvent) => void) | undefined;

  public subscribe(listener: (event: SignalingEvent) => void): () => void {
    this.#listener = listener;
    return (): void => {
      this.#listener = undefined;
    };
  }

  public emit(event: SignalingEvent): void {
    this.#listener?.(event);
  }

  public async start(): Promise<void> {
    return;
  }

  public async register(): Promise<void> {
    return;
  }

  public async unregister(): Promise<void> {
    return;
  }

  public async stop(): Promise<void> {
    return;
  }

  public async destroy(): Promise<void> {
    return;
  }

  public async makeCall(callId: string, destination: string): Promise<void> {
    this.outgoing.push({ callId, destination });
  }

  public async answerCall(): Promise<void> {
    return;
  }

  public async rejectCall(callId: string, statusCode: number): Promise<void> {
    this.rejected.push({ callId, statusCode });
  }

  public async hangupCall(): Promise<void> {
    this.hangupCount += 1;
  }

  public async setMuted(callId: string, muted: boolean): Promise<void> {
    this.muteChanges.push({ callId, muted });
  }

  public async setHold(callId: string, held: boolean): Promise<void> {
    this.holdChanges.push({ callId, held });
    if (this.holdError !== undefined) {
      throw this.holdError;
    }
    await this.holdOperation;
  }

  public async sendDtmf(callId: string, tones: string): Promise<void> {
    this.dtmfRequests.push({ callId, tones });
  }

  public async blindTransfer(callId: string, destination: string): Promise<void> {
    this.transfers.push({ callId, destination });
  }

  public async selectAudioInput(): Promise<void> {
    return;
  }

  public async selectCallAudioOutput(): Promise<void> {
    return;
  }

  public async selectRingtoneOutput(): Promise<void> {
    return;
  }

  public async unlockAudio(): Promise<{ readonly status: 'unlocked' }> {
    return { status: 'unlocked' };
  }

  public getCapabilities(): MiCallCapabilities {
    return {
      audioOutputSelection: true,
      rtpDtmf: true,
      sipInfoDtmfFallback: true,
      blindTransfer: true,
    };
  }
}

function createFixture(): { client: MiCallClient; signaling: FakeSignaling } {
  const signaling = new FakeSignaling();
  let now = 1_000;
  let id = 0;
  return {
    signaling,
    client: new MiCallClient({
      signaling,
      clock: { now: () => ++now },
      ids: { next: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}` },
    }),
  };
}

async function createActiveOutgoingCall(
  client: MiCallClient,
  signaling: FakeSignaling,
): Promise<string> {
  const call = await client.makeCall({ destination: '1001' });
  signaling.emit({ type: 'call-state', callId: call.callId, state: 'establishing' });
  signaling.emit({ type: 'call-state', callId: call.callId, state: 'active' });
  return call.callId;
}

describe('MiCallClient', () => {
  it('commits incoming state before emitting an immutable JSON-safe snapshot', () => {
    const { client, signaling } = createFixture();
    let receivedState: string | undefined;

    client.on('incomingCall', ({ callId, snapshot }) => {
      receivedState = client.getCall(callId)?.state;
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.metadata)).toBe(true);
      expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    });
    signaling.emit({
      type: 'incoming-call',
      callId: 'incoming-1',
      remoteIdentity: 'Nguyễn Văn A',
      remoteAddress: '1001',
      metadata: { 'x-ticket': 'T-1' },
    });

    expect(receivedState).toBe('incoming-ringing');
    expect(client.getCall('incoming-1')?.remoteIdentity).toBe('Nguyễn Văn A');
    expect(client.getCall('incoming-1')?.remoteAddress).toBe('1001');
  });

  it('orders terminal state before callEnded and emits it exactly once', async () => {
    const { client, signaling } = createFixture();
    const events: string[] = [];
    client.on('callStateChanged', ({ state }) => events.push(`state:${state}`));
    client.on('callEnded', ({ reason }) => events.push(`ended:${reason}`));
    signaling.emit({
      type: 'incoming-call',
      callId: 'incoming-1',
      remoteIdentity: '1001',
      metadata: {},
    });

    await client.answerCall('incoming-1');
    signaling.emit({ type: 'call-state', callId: 'incoming-1', state: 'active' });
    signaling.emit({ type: 'call-ended', callId: 'incoming-1', reason: 'remote-hangup' });
    signaling.emit({ type: 'call-ended', callId: 'incoming-1', reason: 'remote-hangup' });

    expect(events).toEqual([
      'state:establishing',
      'state:active',
      'state:ended',
      'ended:remote-hangup',
    ]);
    expect(client.getCall('incoming-1')?.endReason).toBe('remote-hangup');
  });

  it('rejects a second incoming call with 486 without changing the current call', async () => {
    const { client, signaling } = createFixture();
    const rejectedEvents: string[] = [];
    client.on('incomingCallRejected', ({ callId }) => rejectedEvents.push(callId));
    signaling.emit({
      type: 'incoming-call',
      callId: 'first',
      remoteIdentity: '1001',
      metadata: {},
    });
    signaling.emit({
      type: 'incoming-call',
      callId: 'second',
      remoteIdentity: '1002',
      metadata: {},
    });
    await Promise.resolve();

    expect(signaling.rejected).toEqual([{ callId: 'second', statusCode: 486 }]);
    expect(rejectedEvents).toEqual(['second']);
    expect(client.getCall('first')?.state).toBe('incoming-ringing');
    expect(client.getCall('second')).toBeUndefined();
  });

  it('serializes concurrent outgoing actions and enforces single-call policy', async () => {
    const { client, signaling } = createFixture();
    const first = await client.makeCall({ destination: '1001' });

    await expect(client.makeCall({ destination: '1002' })).rejects.toMatchObject({
      code: 'CALL_ALREADY_EXISTS',
      callId: first.callId,
    });
    expect(signaling.outgoing).toHaveLength(1);
  });

  it('maps outgoing provisional progress into ringing and early-media states', async () => {
    const { client, signaling } = createFixture();
    const call = await client.makeCall({ destination: '1001' });

    signaling.emit({ type: 'call-state', callId: call.callId, state: 'outgoing-ringing' });
    expect(client.getCall(call.callId)?.state).toBe('outgoing-ringing');

    signaling.emit({ type: 'call-state', callId: call.callId, state: 'early-media' });
    expect(client.getCall(call.callId)?.state).toBe('early-media');
  });

  it('keeps an active WebRTC call when the signaling transport disconnects', async () => {
    const { client, signaling } = createFixture();
    const call = await client.makeCall({ destination: '1001' });
    signaling.emit({ type: 'call-state', callId: call.callId, state: 'establishing' });
    signaling.emit({ type: 'call-state', callId: call.callId, state: 'active' });

    signaling.emit({ type: 'transport-state', state: 'reconnecting' });

    expect(client.transportState).toBe('reconnecting');
    expect(client.getCall(call.callId)?.state).toBe('active');
  });

  it('makes repeated hangup calls idempotent', async () => {
    const { client, signaling } = createFixture();
    const call = await client.makeCall({ destination: '1001' });

    await client.hangupCall(call.callId);
    await client.hangupCall(call.callId);

    expect(signaling.hangupCount).toBe(1);
    expect(client.getCall(call.callId)?.state).toBe('terminating');
  });

  it('commits mute and hold only after the signaling adapter accepts the action', async () => {
    const { client, signaling } = createFixture();
    const callId = await createActiveOutgoingCall(client, signaling);

    await client.setMuted(callId, true);
    await client.setHold(callId, true);

    expect(signaling.muteChanges).toEqual([{ callId, muted: true }]);
    expect(signaling.holdChanges).toEqual([{ callId, held: true }]);
    expect(client.getCall(callId)).toMatchObject({ muted: true, localHold: true });
  });

  it('keeps the previous hold state when the remote peer rejects re-INVITE', async () => {
    const { client, signaling } = createFixture();
    const callId = await createActiveOutgoingCall(client, signaling);
    signaling.holdError = new MiCallError('HOLD_REJECTED', 'Rejected', { recoverable: true });

    await expect(client.setHold(callId, true)).rejects.toMatchObject({ code: 'HOLD_REJECTED' });

    expect(client.getCall(callId)?.localHold).toBe(false);
  });

  it('publishes network quality changes in the call snapshot', async () => {
    const { client, signaling } = createFixture();
    const callId = await createActiveOutgoingCall(client, signaling);
    const metrics: number[] = [];
    let callStateEventCount = 0;
    client.on('callNetworkMetricsChanged', (event) => {
      metrics.push(event.networkKilobytesPerSecond ?? 0);
    });
    client.on('callStateChanged', () => {
      callStateEventCount += 1;
    });

    signaling.emit({
      type: 'call-properties',
      callId,
      networkQuality: 'fair',
      networkKilobytesPerSecond: 18.4,
    });

    expect(client.getCall(callId)?.networkQuality).toBe('fair');
    expect(client.getCall(callId)?.networkKilobytesPerSecond).toBe(18.4);
    expect(metrics).toEqual([18.4]);
    expect(callStateEventCount).toBe(0);
  });

  it('normalizes valid DTMF and rejects invalid characters before signaling', async () => {
    const { client, signaling } = createFixture();
    const callId = await createActiveOutgoingCall(client, signaling);

    await client.sendDtmf(callId, '12a#');
    await expect(client.sendDtmf(callId, '12,3')).rejects.toMatchObject({
      code: 'DTMF_UNSUPPORTED',
    });

    expect(signaling.dtmfRequests).toEqual([{ callId, tones: '12A#' }]);
  });

  it('emits immutable transfer progress with the current call snapshot', async () => {
    const { client, signaling } = createFixture();
    const callId = await createActiveOutgoingCall(client, signaling);
    const states: string[] = [];
    client.on('transferStateChanged', (event) => {
      states.push(event.state);
      expect(event.snapshot.state).toBe('active');
      expect(Object.isFrozen(event)).toBe(true);
    });

    const transfer = client.blindTransfer(callId, '2001');
    await transfer;
    signaling.emit({
      type: 'transfer-state',
      callId,
      destination: '2001',
      state: 'initiating',
    });
    signaling.emit({
      type: 'transfer-state',
      callId,
      destination: '2001',
      state: 'completed',
    });

    expect(signaling.transfers).toEqual([{ callId, destination: '2001' }]);
    expect(states).toEqual(['initiating', 'completed']);
  });

  it('allows hangup to supersede a hold transaction that is still pending', async () => {
    const { client, signaling } = createFixture();
    const callId = await createActiveOutgoingCall(client, signaling);
    let finishHold = (): void => undefined;
    signaling.holdOperation = new Promise<void>((resolve) => {
      finishHold = resolve;
    });

    const hold = client.setHold(callId, true);
    await Promise.resolve();
    await client.hangupCall(callId);
    finishHold();
    await hold;

    expect(signaling.hangupCount).toBe(1);
    expect(client.getCall(callId)).toMatchObject({ state: 'terminating', localHold: false });
  });

  it('ignores late signaling events after destroy', async () => {
    const { client, signaling } = createFixture();
    const received: string[] = [];
    client.on('incomingCall', ({ callId }) => received.push(callId));

    await client.destroy();
    signaling.emit({
      type: 'incoming-call',
      callId: 'late',
      remoteIdentity: '1001',
      metadata: {},
    });

    expect(received).toEqual([]);
    await expect(client.makeCall({ destination: '1001' })).rejects.toBeInstanceOf(MiCallError);
  });
});
