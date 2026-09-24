import {
  canTransitionCall,
  createCallSnapshot,
  type CallEndReason,
  type CallSnapshot,
  type CallState,
  type AudioUnlockResult,
  type MiCallCapabilities,
  type RegistrationState,
  type TransportState,
} from './domain.js';
import { MiCallError, toMiCallError } from './errors.js';
import { TypedEventEmitter, type MiCallEventMap, type Unsubscribe } from './events.js';
import type { CoreDependencies, OutgoingCallRequest, SignalingEvent } from './ports.js';

export class MiCallClient {
  readonly #events: TypedEventEmitter<MiCallEventMap>;
  readonly #calls = new Map<string, CallSnapshot>();
  readonly #hangups = new Map<string, Promise<void>>();
  readonly #dependencies: CoreDependencies;
  readonly #unsubscribeSignaling: Unsubscribe;
  #transportState: TransportState = 'stopped';
  #registrationState: RegistrationState = 'unregistered';
  #actionQueue: Promise<void> = Promise.resolve();
  #destroyed = false;
  #generation = 0;

  public constructor(dependencies: CoreDependencies) {
    this.#dependencies = dependencies;
    this.#events = new TypedEventEmitter<MiCallEventMap>((error) => {
      dependencies.logger?.log('warn', 'A consumer event listener threw an exception.', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    });
    this.#unsubscribeSignaling = dependencies.signaling.subscribe((event) => {
      this.#handleSignalingEvent(event);
    });
  }

  public get transportState(): TransportState {
    return this.#transportState;
  }

  public get registrationState(): RegistrationState {
    return this.#registrationState;
  }

  public on<EventName extends keyof MiCallEventMap>(
    eventName: EventName,
    listener: (payload: MiCallEventMap[EventName]) => void,
  ): Unsubscribe {
    return this.#events.on(eventName, listener);
  }

  public getCall(callId: string): CallSnapshot | undefined {
    return this.#calls.get(callId);
  }

  public getCalls(): readonly CallSnapshot[] {
    return Object.freeze([...this.#calls.values()]);
  }

  public start(): Promise<void> {
    return this.#enqueue(async (generation) => {
      this.#assertUsable();
      if (this.#transportState !== 'stopped') {
        return;
      }
      this.#setTransportState('connecting');
      try {
        await this.#dependencies.signaling.start();
      } catch (error) {
        const typedError = toMiCallError(
          error,
          'TRANSPORT_FAILED',
          'Unable to start SIP transport.',
        );
        if (this.#isCurrent(generation)) {
          this.#setTransportState('disconnected');
          this.#emitError(typedError);
        }
        throw typedError;
      }
    });
  }

  public register(): Promise<void> {
    return this.#enqueue(async (generation) => {
      this.#assertUsable();
      if (this.#registrationState === 'registered' || this.#registrationState === 'registering') {
        return;
      }
      this.#setRegistrationState('registering');
      try {
        await this.#dependencies.signaling.register();
      } catch (error) {
        const typedError = toMiCallError(
          error,
          'REGISTRATION_FAILED',
          'Unable to register the SIP account.',
        );
        if (this.#isCurrent(generation)) {
          this.#setRegistrationState('failed');
          this.#emitError(typedError);
        }
        throw typedError;
      }
    });
  }

  public unregister(): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertUsable();
      if (
        this.#registrationState === 'unregistered' ||
        this.#registrationState === 'unregistering'
      ) {
        return;
      }
      this.#setRegistrationState('unregistering');
      await this.#dependencies.signaling.unregister();
    });
  }

  public stop(): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertUsable();
      if (this.#transportState === 'stopped') {
        return;
      }
      await this.#dependencies.signaling.stop();
      this.#setRegistrationState('unregistered');
      this.#setTransportState('stopped');
    });
  }

  public async destroy(): Promise<void> {
    if (this.#destroyed) {
      return;
    }

    this.#destroyed = true;
    this.#generation += 1;
    this.#unsubscribeSignaling();
    try {
      await this.#dependencies.signaling.destroy();
    } finally {
      this.#events.clear();
      this.#calls.clear();
      this.#hangups.clear();
      this.#transportState = 'stopped';
      this.#registrationState = 'unregistered';
    }
  }

  public makeCall(request: OutgoingCallRequest): Promise<CallSnapshot> {
    return this.#enqueueWithResult(async (generation) => {
      this.#assertUsable();
      const destination = request.destination.trim();
      if (destination.length === 0) {
        throw new MiCallError('INVALID_DESTINATION', 'Destination must not be empty.');
      }
      this.#assertNoLiveCall();

      const now = this.#dependencies.clock.now();
      const callId = this.#dependencies.ids.next();
      const snapshot = createCallSnapshot({
        callId,
        direction: 'outgoing',
        state: 'outgoing-dialing',
        muted: false,
        localHold: false,
        remoteHold: false,
        remoteIdentity: request.remoteIdentity?.trim() || destination,
        remoteAddress: destination,
        networkQuality: 'unknown',
        metadata: request.metadata ?? {},
        createdAt: now,
        updatedAt: now,
      });
      this.#calls.set(callId, snapshot);

      try {
        await this.#dependencies.signaling.makeCall(callId, destination);
      } catch (error) {
        const typedError = toMiCallError(
          error,
          'CALL_FAILED',
          'Unable to start outgoing call.',
          callId,
        );
        if (this.#isCurrent(generation)) {
          this.#endCall(callId, 'failed');
          this.#emitError(typedError);
        }
        throw typedError;
      }

      return this.#calls.get(callId) ?? snapshot;
    });
  }

  public answerCall(callId: string): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertUsable();
      const call = this.#requireCall(callId);
      if (call.state === 'establishing' || call.state === 'active') {
        return;
      }
      if (call.direction !== 'incoming' || call.state !== 'incoming-ringing') {
        throw this.#invalidCallState(call, 'answer');
      }

      this.#transitionCall(callId, 'establishing');
      await this.#dependencies.signaling.answerCall(callId);
    });
  }

  public rejectCall(callId: string): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertUsable();
      const call = this.#requireCall(callId);
      if (call.state === 'terminating' || call.state === 'ended') {
        return;
      }
      if (call.direction !== 'incoming' || call.state !== 'incoming-ringing') {
        throw this.#invalidCallState(call, 'reject');
      }

      this.#transitionCall(callId, 'terminating');
      await this.#dependencies.signaling.rejectCall(callId, 486);
    });
  }

  public hangupCall(callId: string): Promise<void> {
    try {
      this.#assertUsable();
      const call = this.#requireCall(callId);
      if (call.state === 'terminating' || call.state === 'ended') {
        return this.#hangups.get(callId) ?? Promise.resolve();
      }
      this.#transitionCall(callId, 'terminating');
      const hangup = this.#dependencies.signaling.hangupCall(callId).finally(() => {
        this.#hangups.delete(callId);
      });
      this.#hangups.set(callId, hangup);
      return hangup;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  public setMuted(callId: string, muted: boolean): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertUsable();
      const call = this.#requireActiveCall(callId, muted ? 'mute' : 'unmute');
      if (call.muted === muted) {
        return;
      }
      try {
        await this.#dependencies.signaling.setMuted(callId, muted);
        this.#updateCallProperties(callId, { muted });
      } catch (error) {
        const typedError = toMiCallError(
          error,
          'CALL_FAILED',
          'Unable to change mute state.',
          callId,
        );
        this.#emitError(typedError);
        throw typedError;
      }
    });
  }

  public setHold(callId: string, held: boolean): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertUsable();
      const call = this.#requireActiveCall(callId, held ? 'hold' : 'resume');
      if (call.localHold === held) {
        return;
      }
      try {
        await this.#dependencies.signaling.setHold(callId, held);
        this.#updateCallProperties(callId, { localHold: held });
      } catch (error) {
        const typedError = toMiCallError(
          error,
          'HOLD_REJECTED',
          'Remote peer rejected hold.',
          callId,
        );
        this.#emitError(typedError);
        throw typedError;
      }
    });
  }

  public sendDtmf(callId: string, tones: string): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertUsable();
      this.#requireActiveCall(callId, 'send DTMF');
      const normalizedTones = tones.toUpperCase();
      if (
        normalizedTones.length === 0 ||
        normalizedTones.length > 64 ||
        !/^[0-9A-D*#]+$/.test(normalizedTones)
      ) {
        throw new MiCallError(
          'DTMF_UNSUPPORTED',
          'DTMF tones must contain only 0-9, A-D, * or #.',
          {
            recoverable: true,
            callId,
          },
        );
      }
      try {
        await this.#dependencies.signaling.sendDtmf(callId, normalizedTones);
      } catch (error) {
        const typedError = toMiCallError(
          error,
          'DTMF_UNSUPPORTED',
          'DTMF is not supported.',
          callId,
        );
        this.#emitError(typedError);
        throw typedError;
      }
    });
  }

  public blindTransfer(callId: string, destination: string): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertUsable();
      this.#requireActiveCall(callId, 'transfer');
      if (destination.trim().length === 0) {
        throw new MiCallError('INVALID_DESTINATION', 'Transfer destination must not be empty.', {
          recoverable: true,
          callId,
        });
      }
      try {
        await this.#dependencies.signaling.blindTransfer(callId, destination.trim());
      } catch (error) {
        const typedError = toMiCallError(
          error,
          'TRANSFER_REJECTED',
          'Blind transfer was rejected.',
          callId,
        );
        this.#emitError(typedError);
        throw typedError;
      }
    });
  }

  public selectAudioInput(deviceId: string): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertUsable();
      await this.#dependencies.signaling.selectAudioInput(deviceId);
    });
  }

  public selectCallAudioOutput(deviceId: string): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertUsable();
      await this.#dependencies.signaling.selectCallAudioOutput(deviceId);
    });
  }

  public selectRingtoneOutput(deviceId: string): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertUsable();
      await this.#dependencies.signaling.selectRingtoneOutput(deviceId);
    });
  }

  public unlockAudio(): Promise<AudioUnlockResult> {
    return this.#enqueueWithResult(async () => {
      this.#assertUsable();
      return this.#dependencies.signaling.unlockAudio();
    });
  }

  public getCapabilities(): MiCallCapabilities {
    this.#assertUsable();
    return this.#dependencies.signaling.getCapabilities();
  }

  #handleSignalingEvent(event: SignalingEvent): void {
    if (this.#destroyed) {
      return;
    }

    switch (event.type) {
      case 'transport-state':
        this.#setTransportState(event.state);
        return;
      case 'registration-state':
        this.#setRegistrationState(event.state);
        return;
      case 'incoming-call':
        this.#handleIncomingCall(event);
        return;
      case 'call-state':
        this.#handleRemoteCallState(event.callId, event.state);
        return;
      case 'call-ended':
        this.#endCall(event.callId, event.reason, event.sipStatusCode);
        return;
      case 'call-properties': {
        const hasNetworkMetrics =
          event.networkQuality !== undefined || event.networkKilobytesPerSecond !== undefined;
        const hasCallControls =
          event.muted !== undefined ||
          event.localHold !== undefined ||
          event.remoteHold !== undefined;
        const updated = this.#updateCallProperties(
          event.callId,
          {
            ...(event.muted === undefined ? {} : { muted: event.muted }),
            ...(event.localHold === undefined ? {} : { localHold: event.localHold }),
            ...(event.remoteHold === undefined ? {} : { remoteHold: event.remoteHold }),
            ...(event.networkQuality === undefined
              ? {}
              : { networkQuality: event.networkQuality }),
            ...(event.networkKilobytesPerSecond === undefined
              ? {}
              : { networkKilobytesPerSecond: event.networkKilobytesPerSecond }),
          },
          hasCallControls,
        );
        if (hasNetworkMetrics && updated !== undefined) {
          this.#events.emit(
            'callNetworkMetricsChanged',
            Object.freeze({
              callId: event.callId,
              networkQuality: updated.networkQuality ?? 'unknown',
              ...(updated.networkKilobytesPerSecond === undefined
                ? {}
                : { networkKilobytesPerSecond: updated.networkKilobytesPerSecond }),
              timestamp: updated.updatedAt,
              snapshot: updated,
            }),
          );
        }
        return;
      }
      case 'audio-unlock-required':
        this.#events.emit(
          'audioUnlockRequired',
          Object.freeze({ callId: event.callId, timestamp: this.#dependencies.clock.now() }),
        );
        return;
      case 'media-devices': {
        const devices = Object.freeze(event.devices.map((device) => Object.freeze({ ...device })));
        this.#events.emit(
          'mediaDevicesChanged',
          Object.freeze({
            devices,
            ...(event.selectedAudioInputId === undefined
              ? {}
              : { selectedAudioInputId: event.selectedAudioInputId }),
            ...(event.selectedCallAudioOutputId === undefined
              ? {}
              : { selectedCallAudioOutputId: event.selectedCallAudioOutputId }),
            ...(event.selectedRingtoneOutputId === undefined
              ? {}
              : { selectedRingtoneOutputId: event.selectedRingtoneOutputId }),
            timestamp: this.#dependencies.clock.now(),
          }),
        );
        return;
      }
      case 'transfer-state': {
        const snapshot = this.#calls.get(event.callId);
        if (snapshot === undefined || snapshot.state === 'ended') {
          return;
        }
        this.#events.emit(
          'transferStateChanged',
          Object.freeze({
            callId: event.callId,
            destination: event.destination,
            state: event.state,
            timestamp: this.#dependencies.clock.now(),
            snapshot,
          }),
        );
        return;
      }
      case 'error':
        this.#emitError(
          new MiCallError(event.code, event.message, {
            recoverable: event.recoverable,
            ...(event.callId === undefined ? {} : { callId: event.callId }),
            context: event.context ?? {},
          }),
        );
    }
  }

  #handleRemoteCallState(
    callId: string,
    state: Exclude<CallState, 'incoming-ringing' | 'outgoing-dialing' | 'ended'>,
  ): void {
    const current = this.#calls.get(callId);
    if (current === undefined || current.state === 'ended' || current.state === 'terminating') {
      return;
    }
    if (!canTransitionCall(current.state, state)) {
      this.#dependencies.logger?.log('warn', 'Ignored invalid signaling transition.', {
        callId,
        from: current.state,
        to: state,
      });
      return;
    }
    this.#transitionCall(callId, state);
  }

  #handleIncomingCall(event: Extract<SignalingEvent, { readonly type: 'incoming-call' }>): void {
    if (this.#findLiveCall() !== undefined) {
      void this.#rejectAdditionalIncomingCall(event.callId);
      return;
    }

    const now = this.#dependencies.clock.now();
    const snapshot = createCallSnapshot({
      callId: event.callId,
      direction: 'incoming',
      state: 'incoming-ringing',
      muted: false,
      localHold: false,
      remoteHold: false,
      remoteIdentity: event.remoteIdentity,
      ...(event.remoteAddress === undefined ? {} : { remoteAddress: event.remoteAddress }),
      networkQuality: 'unknown',
      metadata: event.metadata,
      createdAt: now,
      updatedAt: now,
    });
    this.#calls.set(event.callId, snapshot);
    this.#events.emit(
      'incomingCall',
      Object.freeze({
        callId: event.callId,
        direction: 'incoming',
        timestamp: now,
        snapshot,
      }),
    );
  }

  async #rejectAdditionalIncomingCall(callId: string): Promise<void> {
    try {
      await this.#dependencies.signaling.rejectCall(callId, 486);
    } finally {
      if (!this.#destroyed) {
        this.#events.emit(
          'incomingCallRejected',
          Object.freeze({
            callId,
            reason: 'busy',
            timestamp: this.#dependencies.clock.now(),
          }),
        );
      }
    }
  }

  #transitionCall(callId: string, nextState: CallState): CallSnapshot {
    const current = this.#requireCall(callId);
    if (current.state === nextState) {
      return current;
    }
    if (!canTransitionCall(current.state, nextState)) {
      throw this.#invalidCallState(current, `transition to ${nextState}`);
    }

    const now = this.#dependencies.clock.now();
    const next = createCallSnapshot({
      ...current,
      state: nextState,
      updatedAt: now,
      ...(nextState === 'active' && current.connectedAt === undefined ? { connectedAt: now } : {}),
    });
    this.#calls.set(callId, next);
    this.#emitCallStateChanged(current, next, now);
    return next;
  }

  #endCall(callId: string, reason: CallEndReason, sipStatusCode?: number): void {
    const current = this.#calls.get(callId);
    if (current === undefined || current.state === 'ended') {
      return;
    }
    if (!canTransitionCall(current.state, 'ended')) {
      return;
    }

    const now = this.#dependencies.clock.now();
    const ended = createCallSnapshot({
      ...current,
      state: 'ended',
      updatedAt: now,
      endedAt: now,
      endReason: reason,
    });
    this.#calls.set(callId, ended);
    this.#emitCallStateChanged(current, ended, now);
    this.#events.emit(
      'callEnded',
      Object.freeze({
        callId,
        direction: ended.direction,
        reason,
        ...(sipStatusCode === undefined ? {} : { sipStatusCode }),
        timestamp: now,
        snapshot: ended,
      }),
    );
  }

  #emitCallStateChanged(previous: CallSnapshot, next: CallSnapshot, timestamp: number): void {
    this.#events.emit(
      'callStateChanged',
      Object.freeze({
        callId: next.callId,
        direction: next.direction,
        previousState: previous.state,
        state: next.state,
        timestamp,
        snapshot: next,
      }),
    );
  }

  #updateCallProperties(
    callId: string,
    changes: Partial<
      Pick<
        CallSnapshot,
        | 'muted'
        | 'localHold'
        | 'remoteHold'
        | 'networkQuality'
        | 'networkKilobytesPerSecond'
      >
    >,
    emitCallStateChanged = true,
  ): CallSnapshot | undefined {
    const current = this.#calls.get(callId);
    if (current === undefined || current.state === 'ended' || current.state === 'terminating') {
      return undefined;
    }
    const now = this.#dependencies.clock.now();
    const next = createCallSnapshot({ ...current, ...changes, updatedAt: now });
    this.#calls.set(callId, next);
    if (emitCallStateChanged) {
      this.#emitCallStateChanged(current, next, now);
    }
    return next;
  }

  #setTransportState(state: TransportState): void {
    if (this.#transportState === state || this.#destroyed) {
      return;
    }
    const previousState = this.#transportState;
    this.#transportState = state;
    this.#events.emit(
      'transportStateChanged',
      Object.freeze({ previousState, state, timestamp: this.#dependencies.clock.now() }),
    );
  }

  #setRegistrationState(state: RegistrationState): void {
    if (this.#registrationState === state || this.#destroyed) {
      return;
    }
    const previousState = this.#registrationState;
    this.#registrationState = state;
    this.#events.emit(
      'registrationStateChanged',
      Object.freeze({ previousState, state, timestamp: this.#dependencies.clock.now() }),
    );
  }

  #emitError(error: MiCallError): void {
    this.#events.emit(
      'error',
      Object.freeze({
        code: error.code,
        message: error.message,
        recoverable: error.recoverable,
        ...(error.callId === undefined ? {} : { callId: error.callId }),
        timestamp: this.#dependencies.clock.now(),
        context: error.context,
      }),
    );
  }

  #findLiveCall(): CallSnapshot | undefined {
    return [...this.#calls.values()].find((call) => call.state !== 'ended');
  }

  #assertNoLiveCall(): void {
    const liveCall = this.#findLiveCall();
    if (liveCall !== undefined) {
      throw new MiCallError('CALL_ALREADY_EXISTS', 'Only one active call is supported.', {
        recoverable: true,
        callId: liveCall.callId,
      });
    }
  }

  #requireCall(callId: string): CallSnapshot {
    const call = this.#calls.get(callId);
    if (call === undefined) {
      throw new MiCallError('CALL_NOT_FOUND', `Call '${callId}' was not found.`, {
        recoverable: true,
        callId,
      });
    }
    return call;
  }

  #requireActiveCall(callId: string, operation: string): CallSnapshot {
    const call = this.#requireCall(callId);
    if (call.state !== 'active') {
      throw this.#invalidCallState(call, operation);
    }
    return call;
  }

  #invalidCallState(call: CallSnapshot, operation: string): MiCallError {
    return new MiCallError(
      'INVALID_CALL_STATE',
      `Cannot ${operation} while call '${call.callId}' is '${call.state}'.`,
      {
        recoverable: true,
        callId: call.callId,
        context: { state: call.state, operation },
      },
    );
  }

  #assertUsable(): void {
    if (this.#destroyed) {
      throw new MiCallError('CLIENT_DESTROYED', 'MiCallClient has been destroyed.');
    }
  }

  #isCurrent(generation: number): boolean {
    return !this.#destroyed && generation === this.#generation;
  }

  #enqueue(task: (generation: number) => Promise<void>): Promise<void> {
    const generation = this.#generation;
    const result = this.#actionQueue.then(() => task(generation));
    this.#actionQueue = result.catch(() => undefined);
    return result;
  }

  #enqueueWithResult<T>(task: (generation: number) => Promise<T>): Promise<T> {
    const generation = this.#generation;
    const result = this.#actionQueue.then(() => task(generation));
    this.#actionQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
