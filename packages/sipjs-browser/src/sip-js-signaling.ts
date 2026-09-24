import {
  MiCallError,
  type AudioDeviceSnapshot,
  type AudioUnlockResult,
  type CallEndReason,
  type IdGenerator,
  type LoggerPort,
  type MiCallCapabilities,
  type RandomSource,
  type Scheduler,
  type SignalingEvent,
  type SignalingPort,
} from '@micall/core';
import {
  Invitation,
  Inviter,
  Registerer,
  RegistererState,
  SessionState,
  UserAgent,
  Web,
  type Notification,
  type Session,
  type URI,
} from 'sip.js';
import {
  DEFAULT_RINGTONE_URL,
  HtmlAudioRingtone,
  type RingtonePort,
} from './browser-media.js';
import { BrowserMediaManager, type BrowserMediaManagerOptions } from './browser-media-manager.js';
import {
  resolveConfig,
  type ResolvedSipJsBrowserConfig,
  type SipJsBrowserConfig,
} from './config.js';
import { extractIncomingMetadata } from './metadata.js';
import { ReconnectCoordinator } from './reconnect-coordinator.js';

const HOLD_TIMEOUT_MS = 15_000;
const TRANSFER_TIMEOUT_MS = 15_000;
const DTMF_INFO_TIMEOUT_MS = 10_000;

class BrowserScheduler implements Scheduler {
  public set(delayMs: number, callback: () => void): unknown {
    return globalThis.setTimeout(callback, delayMs);
  }

  public clear(handle: unknown): void {
    globalThis.clearTimeout(handle as number);
  }
}

class BrowserRandom implements RandomSource {
  public next(): number {
    return Math.random();
  }
}

class BrowserUuidGenerator implements IdGenerator {
  public next(): string {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
    throw new MiCallError('INTERNAL_ERROR', 'crypto.randomUUID() is required to create a callId.');
  }
}

interface ManagedSession {
  readonly callId: string;
  readonly direction: 'incoming' | 'outgoing';
  readonly session: Session;
  readonly stateListener: (state: SessionState) => void;
  established: boolean;
  terminalEmitted: boolean;
  localEndReason: CallEndReason | undefined;
  timeoutHandle: unknown;
  holdInFlight: boolean;
  transferInFlight: boolean;
  controlGeneration: number;
  readonly controlAborters: Set<() => void>;
}

export interface SipJsSignalingDependencies {
  readonly media?: BrowserMediaManager;
  readonly mediaOptions?: BrowserMediaManagerOptions;
  readonly ringtone?: RingtonePort;
  readonly scheduler?: Scheduler;
  readonly random?: RandomSource;
  readonly ids?: IdGenerator;
  readonly logger?: LoggerPort;
}

export class SipJsSignaling implements SignalingPort {
  readonly #config: ResolvedSipJsBrowserConfig;
  readonly #userAgent: UserAgent;
  readonly #registerer: Registerer;
  readonly #media: BrowserMediaManager;
  readonly #ringtone: RingtonePort | undefined;
  readonly #scheduler: Scheduler;
  readonly #ids: IdGenerator;
  readonly #logger: LoggerPort | undefined;
  readonly #reconnect: ReconnectCoordinator;
  readonly #listeners = new Set<(event: SignalingEvent) => void>();
  readonly #sessions = new Map<string, ManagedSession>();
  readonly #registererStateListener: (state: RegistererState) => void;
  #desiredRegistration = false;
  #registrationRequestInFlight = false;
  #started = false;
  #destroyed = false;
  #lastDevices: readonly AudioDeviceSnapshot[] = Object.freeze([]);
  #selectedRingtoneOutputId: string | undefined;

  public constructor(config: SipJsBrowserConfig, dependencies: SipJsSignalingDependencies = {}) {
    this.#config = resolveConfig(config);
    this.#ringtone =
      dependencies.ringtone ??
      new HtmlAudioRingtone(this.#config.ringtoneUrl ?? DEFAULT_RINGTONE_URL);
    this.#scheduler = dependencies.scheduler ?? new BrowserScheduler();
    this.#ids = dependencies.ids ?? new BrowserUuidGenerator();
    this.#logger = dependencies.logger;
    this.#media =
      dependencies.media ??
      new BrowserMediaManager({
        ...dependencies.mediaOptions,
        ...(this.#logger === undefined ? {} : { logger: this.#logger }),
        onAudioUnlockRequired: (callId) => {
          this.#emit({ type: 'audio-unlock-required', callId });
        },
        onNetworkQualityChanged: (callId, networkQuality) => {
          this.#emit({ type: 'call-properties', callId, networkQuality });
        },
        onNetworkThroughputChanged: (callId, networkKilobytesPerSecond) => {
          this.#emit({ type: 'call-properties', callId, networkKilobytesPerSecond });
        },
        onDevicesChanged: (devices, selection) => {
          this.#lastDevices = devices;
          if (
            this.#selectedRingtoneOutputId !== undefined &&
            !devices.some(
              (device) =>
                device.kind === 'audiooutput' && device.deviceId === this.#selectedRingtoneOutputId,
            )
          ) {
            this.#selectedRingtoneOutputId = undefined;
            if (this.#ringtone?.supportsOutputSelection() === true) {
              void this.#ringtone.setOutputDevice('default').catch(() => undefined);
            }
            this.#emitError(
              new MiCallError(
                'MEDIA_DEVICE_NOT_FOUND',
                'Selected ringtone output was disconnected; falling back to the default device.',
                { recoverable: true },
              ),
            );
          }
          this.#emit({
            type: 'media-devices',
            devices,
            ...(selection.audioInputId === undefined
              ? {}
              : { selectedAudioInputId: selection.audioInputId }),
            ...(selection.callAudioOutputId === undefined
              ? {}
              : { selectedCallAudioOutputId: selection.callAudioOutputId }),
            ...(this.#selectedRingtoneOutputId === undefined
              ? {}
              : { selectedRingtoneOutputId: this.#selectedRingtoneOutputId }),
          });
        },
        onError: (error) => {
          this.#emitError(error);
        },
      });

    const uri = UserAgent.makeURI(this.#config.uri);
    if (uri === undefined) {
      throw new MiCallError('INVALID_CONFIG', 'sip.uri could not be parsed by SIP.js.');
    }

    this.#userAgent = new UserAgent({
      uri,
      authorizationUsername: this.#config.authorizationUsername,
      authorizationPassword: this.#config.authorizationPassword,
      ...(this.#config.displayName === undefined ? {} : { displayName: this.#config.displayName }),
      transportOptions: { server: this.#config.wssServer },
      sessionDescriptionHandlerFactory: Web.defaultSessionDescriptionHandlerFactory(
        this.#media.mediaStreamFactory,
      ),
      ...(this.#config.iceServers === undefined
        ? {}
        : {
            sessionDescriptionHandlerFactoryOptions: {
              peerConnectionConfiguration: { iceServers: [...this.#config.iceServers] },
            },
          }),
      logBuiltinEnabled: false,
      logConfiguration: false,
      reconnectionAttempts: 0,
      noAnswerTimeout: 2_147_000,
      delegate: {
        onConnect: () => {
          this.#handleConnected();
        },
        onDisconnect: (error) => {
          this.#handleDisconnected(error);
        },
        onInvite: (invitation) => {
          this.#handleInvitation(invitation);
        },
      },
    });
    this.#registerer = new Registerer(this.#userAgent, {
      expires: this.#config.registerExpiresSeconds,
    });
    this.#registererStateListener = (state): void => {
      this.#handleRegistererState(state);
    };
    this.#registerer.stateChange.addListener(this.#registererStateListener);
    this.#reconnect = new ReconnectCoordinator({
      reconnect: async () => this.#userAgent.reconnect(),
      scheduler: this.#scheduler,
      random: dependencies.random ?? new BrowserRandom(),
      ...(this.#logger === undefined ? {} : { logger: this.#logger }),
    });
  }

  public subscribe(listener: (event: SignalingEvent) => void): () => void {
    this.#listeners.add(listener);
    return (): void => {
      this.#listeners.delete(listener);
    };
  }

  public async start(): Promise<void> {
    this.#assertUsable();
    if (this.#started) {
      return;
    }
    this.#started = true;
    this.#media.start();
    this.#reconnect.start();
    this.#emit({ type: 'transport-state', state: 'connecting' });
    try {
      await this.#userAgent.start();
      if (this.#userAgent.isConnected()) {
        this.#handleConnected();
      }
    } catch (error) {
      this.#started = false;
      this.#reconnect.stop();
      this.#emit({ type: 'transport-state', state: 'disconnected' });
      throw new MiCallError('TRANSPORT_FAILED', 'SIP WebSocket could not be started.', {
        recoverable: true,
        cause: error,
      });
    }
  }

  public async register(): Promise<void> {
    this.#assertUsable();
    this.#desiredRegistration = true;
    this.#emit({ type: 'registration-state', state: 'registering' });
    if (!this.#userAgent.isConnected()) {
      return;
    }
    await this.#performRegister();
  }

  public async unregister(): Promise<void> {
    this.#assertUsable();
    this.#desiredRegistration = false;
    if (
      this.#registerer.state === RegistererState.Unregistered ||
      this.#registerer.state === RegistererState.Terminated
    ) {
      this.#emit({ type: 'registration-state', state: 'unregistered' });
      return;
    }
    this.#emit({ type: 'registration-state', state: 'unregistering' });
    await this.#registerer.unregister();
  }

  public async stop(): Promise<void> {
    if (!this.#started) {
      return;
    }
    this.#desiredRegistration = false;
    this.#reconnect.stop();
    if (this.#registerer.state === RegistererState.Registered) {
      try {
        await this.#registerer.unregister();
      } catch (error) {
        this.#logger?.log('warn', 'SIP unregister during stop failed.', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      }
    }
    await this.#userAgent.stop();
    this.#started = false;
    this.#emit({ type: 'registration-state', state: 'unregistered' });
    this.#emit({ type: 'transport-state', state: 'stopped' });
  }

  public async destroy(): Promise<void> {
    if (this.#destroyed) {
      return;
    }
    await this.stop();
    this.#destroyed = true;
    this.#registerer.stateChange.removeListener(this.#registererStateListener);
    await this.#registerer.dispose();
    for (const managed of [...this.#sessions.values()]) {
      managed.controlGeneration += 1;
      this.#cancelControlTransactions(managed);
      this.#clearCallTimeout(managed);
      managed.session.stateChange.removeListener(managed.stateListener);
      this.#ringtone?.stop(managed.callId);
      this.#media.release(managed.callId);
    }
    this.#sessions.clear();
    this.#media.destroy();
    this.#ringtone?.destroy();
    this.#listeners.clear();
  }

  public async makeCall(callId: string, destination: string): Promise<void> {
    this.#assertUsable();
    const target = this.#parseDestination(destination);
    const inviter = new Inviter(this.#userAgent, target, { earlyMedia: true });
    const managed = this.#manageSession(callId, 'outgoing', inviter);

    try {
      managed.timeoutHandle = this.#scheduler.set(this.#config.outgoingCallTimeoutMs, () => {
        void this.#timeoutOutgoingCall(managed);
      });
      await inviter.invite({
        requestDelegate: {
          onProgress: (response) => {
            const statusCode = response.message.statusCode;
            if (statusCode === 180) {
              this.#emit({ type: 'call-state', callId, state: 'outgoing-ringing' });
            } else if (statusCode === 183) {
              this.#emit({ type: 'call-state', callId, state: 'early-media' });
            }
          },
          onRedirect: (response) => {
            this.#emitEnded(managed, 'failed', response.message.statusCode);
          },
          onReject: (response) => {
            const statusCode = response.message.statusCode;
            this.#emitEnded(managed, mapRejectedInvite(statusCode), statusCode);
          },
        },
      });
    } catch (error) {
      this.#emitEnded(managed, 'failed');
      if (error instanceof MiCallError) {
        throw error;
      }
      throw new MiCallError(
        isMediaPermissionError(error) ? 'MEDIA_PERMISSION_DENIED' : 'CALL_FAILED',
        isMediaPermissionError(error)
          ? 'Microphone permission is required to make a call.'
          : 'SIP INVITE could not be sent.',
        { recoverable: true, callId, cause: error },
      );
    }
  }

  public async answerCall(callId: string): Promise<void> {
    this.#assertUsable();
    const managed = this.#requireSession(callId);
    if (!(managed.session instanceof Invitation)) {
      throw this.#invalidSessionAction(callId, 'answer');
    }

    this.#ringtone?.stop(callId);
    try {
      await managed.session.accept();
    } catch (error) {
      if (this.#sessions.has(callId) && managed.session.state === SessionState.Initial) {
        managed.localEndReason = 'failed';
        try {
          await managed.session.reject({
            statusCode: 480,
            reasonPhrase: 'Temporarily Unavailable',
          });
        } catch (rejectError) {
          this.#logger?.log('warn', 'Failed incoming call could not be rejected cleanly.', {
            callId,
            errorName: rejectError instanceof Error ? rejectError.name : 'UnknownError',
          });
        } finally {
          this.#emitEnded(managed, 'failed', 480);
        }
      }
      const mediaFailure = isMediaPermissionError(error);
      const typedError =
        error instanceof MiCallError
          ? error
          : new MiCallError(
              mediaFailure ? 'MEDIA_PERMISSION_DENIED' : 'CALL_FAILED',
              mediaFailure
                ? 'Microphone permission is required.'
                : 'Incoming call could not be answered.',
              {
                recoverable: true,
                callId,
                cause: error,
              },
            );
      this.#emitError(typedError);
      throw typedError;
    }
  }

  public async rejectCall(callId: string, statusCode: number): Promise<void> {
    this.#assertUsable();
    const managed = this.#requireSession(callId);
    if (!(managed.session instanceof Invitation) || managed.established) {
      throw this.#invalidSessionAction(callId, 'reject');
    }
    managed.localEndReason = 'rejected';
    this.#ringtone?.stop(callId);
    await managed.session.reject({ statusCode });
    this.#emitEnded(managed, 'rejected', statusCode);
  }

  public async hangupCall(callId: string): Promise<void> {
    this.#assertUsable();
    const managed = this.#requireSession(callId);
    managed.controlGeneration += 1;
    this.#cancelControlTransactions(managed);
    this.#ringtone?.stop(callId);

    if (managed.established || managed.session.state === SessionState.Established) {
      managed.localEndReason = 'local-hangup';
      await managed.session.bye();
      return;
    }
    if (managed.session instanceof Invitation) {
      managed.localEndReason = 'rejected';
      await managed.session.reject({ statusCode: 486, reasonPhrase: 'Busy Here' });
      this.#emitEnded(managed, 'rejected', 486);
      return;
    }
    if (managed.session instanceof Inviter) {
      managed.localEndReason = 'local-cancel';
      await managed.session.cancel();
      return;
    }
    throw this.#invalidSessionAction(callId, 'hang up');
  }

  public async setMuted(callId: string, muted: boolean): Promise<void> {
    this.#assertEstablished(callId, 'change mute state');
    await this.#media.setMuted(callId, muted);
  }

  public async setHold(callId: string, held: boolean): Promise<void> {
    this.#assertUsable();
    const managed = this.#assertEstablished(callId, held ? 'hold' : 'resume');
    if (managed.holdInFlight) {
      throw new MiCallError('HOLD_REJECTED', 'A hold transaction is already in progress.', {
        recoverable: true,
        callId,
      });
    }

    managed.holdInFlight = true;
    const generation = managed.controlGeneration;
    let cancelPending = (): void => undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let timeoutHandle: unknown = undefined;
        const finish = (outcome: () => void): void => {
          if (settled) {
            return;
          }
          settled = true;
          if (timeoutHandle !== undefined) {
            this.#scheduler.clear(timeoutHandle);
          }
          outcome();
        };
        cancelPending = (): void => finish(resolve);
        managed.controlAborters.add(cancelPending);
        timeoutHandle = this.#scheduler.set(HOLD_TIMEOUT_MS, () => {
          finish(() =>
            reject(
              new MiCallError('HOLD_REJECTED', 'Hold request timed out.', {
                recoverable: true,
                callId,
                context: { reason: 'timeout' },
              }),
            ),
          );
        });
        void managed.session
          .invite({
            sessionDescriptionHandlerOptions: {
              hold: held,
            } as Web.SessionDescriptionHandlerOptions,
            requestDelegate: {
              onAccept: () => finish(resolve),
              onRedirect: (response) =>
                finish(() =>
                  reject(
                    new MiCallError('HOLD_REJECTED', 'Hold re-INVITE was redirected.', {
                      recoverable: true,
                      callId,
                      context: { statusCode: response.message.statusCode ?? 0 },
                    }),
                  ),
                ),
              onReject: (response) =>
                finish(() =>
                  reject(
                    new MiCallError('HOLD_REJECTED', 'Remote peer rejected hold.', {
                      recoverable: true,
                      callId,
                      context: { statusCode: response.message.statusCode ?? 0 },
                    }),
                  ),
                ),
            },
          })
          .catch((error: unknown) => {
            finish(() =>
              reject(
                new MiCallError('HOLD_REJECTED', 'Unable to send hold re-INVITE.', {
                  recoverable: true,
                  callId,
                  cause: error,
                }),
              ),
            );
          });
      });
      if (generation !== managed.controlGeneration || managed.terminalEmitted) {
        return;
      }
    } finally {
      managed.controlAborters.delete(cancelPending);
      managed.holdInFlight = false;
    }
  }

  public async sendDtmf(callId: string, tones: string): Promise<void> {
    const managed = this.#assertEstablished(callId, 'send DTMF');
    const handler = managed.session.sessionDescriptionHandler;
    try {
      if (handler?.sendDtmf(tones) === true) {
        return;
      }
    } catch (error) {
      this.#logger?.log('warn', 'RTP DTMF failed; falling back to SIP INFO.', {
        callId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }

    for (const tone of tones) {
      if (managed.terminalEmitted || managed.session.state !== SessionState.Established) {
        return;
      }
      await this.#sendDtmfInfo(managed, tone);
    }
  }

  public async blindTransfer(callId: string, destination: string): Promise<void> {
    const managed = this.#assertEstablished(callId, 'transfer');
    if (managed.transferInFlight) {
      throw new MiCallError('TRANSFER_REJECTED', 'A transfer is already in progress.', {
        recoverable: true,
        callId,
      });
    }
    const target = this.#parseDestination(destination);
    managed.transferInFlight = true;
    const generation = managed.controlGeneration;
    let cancelPending = (): void => undefined;
    this.#emit({ type: 'transfer-state', callId, destination, state: 'initiating' });

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let timeoutHandle: unknown = undefined;
        const finish = (outcome: () => void): void => {
          if (settled) {
            return;
          }
          settled = true;
          if (timeoutHandle !== undefined) {
            this.#scheduler.clear(timeoutHandle);
          }
          outcome();
        };
        const fail = (error: MiCallError): void => {
          finish(() => {
            this.#emit({ type: 'transfer-state', callId, destination, state: 'failed' });
            reject(error);
          });
        };
        const complete = (): void => {
          finish(() => {
            void this.#completeTransfer(managed, destination, generation).then(resolve, reject);
          });
        };
        cancelPending = (): void => finish(resolve);
        managed.controlAborters.add(cancelPending);
        timeoutHandle = this.#scheduler.set(TRANSFER_TIMEOUT_MS, () => {
          fail(
            new MiCallError('TRANSFER_REJECTED', 'Blind transfer timed out.', {
              recoverable: true,
              callId,
              context: { reason: 'timeout' },
            }),
          );
        });

        void managed.session
          .refer(target, {
            requestDelegate: {
              onAccept: complete,
              onRedirect: (response) =>
                fail(
                  new MiCallError('TRANSFER_REJECTED', 'PBX redirected blind transfer.', {
                    recoverable: true,
                    callId,
                    context: { statusCode: response.message.statusCode ?? 0 },
                  }),
                ),
              onReject: (response) =>
                fail(
                  new MiCallError('TRANSFER_REJECTED', 'PBX rejected blind transfer.', {
                    recoverable: true,
                    callId,
                    context: { statusCode: response.message.statusCode ?? 0 },
                  }),
                ),
            },
            onNotify: (notification) => {
              void notification.accept().catch((error: unknown) => {
                this.#logger?.log('warn', 'Unable to acknowledge transfer NOTIFY.', {
                  callId,
                  errorName: error instanceof Error ? error.name : 'UnknownError',
                });
              });
              const statusCode = parseNotifyStatus(notification);
              if (statusCode !== undefined && statusCode >= 200 && statusCode < 300) {
                complete();
              } else if (statusCode !== undefined && statusCode >= 300) {
                fail(
                  new MiCallError('TRANSFER_REJECTED', 'Transfer NOTIFY reported failure.', {
                    recoverable: true,
                    callId,
                    context: { statusCode },
                  }),
                );
              }
            },
          })
          .catch((error: unknown) => {
            fail(
              new MiCallError('TRANSFER_REJECTED', 'Unable to send SIP REFER.', {
                recoverable: true,
                callId,
                cause: error,
              }),
            );
          });
      });
    } finally {
      managed.controlAborters.delete(cancelPending);
      managed.transferInFlight = false;
    }
  }

  public async selectAudioInput(deviceId: string): Promise<void> {
    this.#assertUsable();
    await this.#media.selectAudioInput(deviceId);
  }

  public async selectCallAudioOutput(deviceId: string): Promise<void> {
    this.#assertUsable();
    await this.#media.selectCallAudioOutput(deviceId);
  }

  public async selectRingtoneOutput(deviceId: string): Promise<void> {
    this.#assertUsable();
    if (this.#ringtone === undefined) {
      throw new MiCallError(
        'AUDIO_OUTPUT_UNSUPPORTED',
        'Ringtone output cannot be selected when no ringtone is configured.',
        { recoverable: true },
      );
    }
    const devices = await this.#media.refreshDevices();
    if (!devices.some((device) => device.kind === 'audiooutput' && device.deviceId === deviceId)) {
      throw new MiCallError('MEDIA_DEVICE_NOT_FOUND', `Audio device '${deviceId}' was not found.`, {
        recoverable: true,
      });
    }
    await this.#ringtone.setOutputDevice(deviceId);
    this.#selectedRingtoneOutputId = deviceId;
    this.#emitMediaDevices();
  }

  public getCapabilities(): MiCallCapabilities {
    const mediaCapabilities = this.#media.getCapabilities();
    return Object.freeze({
      audioOutputSelection:
        mediaCapabilities.audioOutputSelection ||
        (this.#ringtone?.supportsOutputSelection() ?? false),
      rtpDtmf: mediaCapabilities.rtpDtmf,
      sipInfoDtmfFallback: true,
      blindTransfer: true,
    });
  }

  public resume(): void {
    if (this.#destroyed || !this.#started) {
      return;
    }
    if (!this.#userAgent.isConnected()) {
      this.#reconnect.resume();
      return;
    }
    if (this.#desiredRegistration && this.#registerer.state !== RegistererState.Registered) {
      void this.#performRegister();
    }
  }

  public async unlockAudio(): Promise<AudioUnlockResult> {
    const results: boolean[] = [];
    if (this.#media.hasAttachedMedia()) {
      results.push(await this.#media.unlockAudio());
    }
    if (this.#ringtone !== undefined) {
      results.push(await this.#ringtone.unlock());
    }
    if (results.length === 0) {
      return Object.freeze({ status: 'not-configured' });
    }
    return Object.freeze({ status: results.every(Boolean) ? 'unlocked' : 'blocked' });
  }

  async #performRegister(): Promise<void> {
    if (this.#registrationRequestInFlight || !this.#desiredRegistration || this.#destroyed) {
      return;
    }
    this.#registrationRequestInFlight = true;
    this.#emit({ type: 'registration-state', state: 'registering' });
    try {
      await this.#registerer.register({
        requestDelegate: {
          onReject: (response) => {
            const statusCode = response.message.statusCode;
            const authenticationFailure = statusCode === 401 || statusCode === 403;
            this.#emit({ type: 'registration-state', state: 'failed' });
            this.#emit({
              type: 'error',
              code: authenticationFailure ? 'AUTHENTICATION_FAILED' : 'REGISTRATION_FAILED',
              message: authenticationFailure
                ? 'SIP authentication was rejected.'
                : 'SIP registration was rejected.',
              recoverable: !authenticationFailure,
              context: { statusCode: statusCode ?? 0 },
            });
          },
        },
      });
    } catch (error) {
      this.#emit({ type: 'registration-state', state: 'failed' });
      throw new MiCallError('REGISTRATION_FAILED', 'SIP REGISTER could not be sent.', {
        recoverable: true,
        cause: error,
      });
    } finally {
      this.#registrationRequestInFlight = false;
    }
  }

  #handleConnected(): void {
    if (this.#destroyed) {
      return;
    }
    this.#reconnect.connected();
    this.#emit({ type: 'transport-state', state: 'connected' });
    if (this.#desiredRegistration) {
      void this.#performRegister();
    }
  }

  #handleDisconnected(error: Error | undefined): void {
    if (this.#destroyed) {
      return;
    }
    if (!this.#started) {
      this.#emit({ type: 'transport-state', state: 'disconnected' });
      return;
    }
    this.#emit({ type: 'transport-state', state: 'reconnecting' });
    if (this.#desiredRegistration) {
      this.#emit({ type: 'registration-state', state: 'unregistered' });
    }
    this.#logger?.log('warn', 'SIP WebSocket disconnected unexpectedly.', {
      errorName: error?.name ?? 'TransportClosed',
    });
    this.#reconnect.disconnected();
  }

  #handleRegistererState(state: RegistererState): void {
    if (this.#destroyed) {
      return;
    }
    switch (state) {
      case RegistererState.Registered:
        this.#emit({ type: 'registration-state', state: 'registered' });
        return;
      case RegistererState.Unregistered:
      case RegistererState.Terminated:
        this.#emit({ type: 'registration-state', state: 'unregistered' });
        return;
      case RegistererState.Initial:
        return;
    }
  }

  #handleInvitation(invitation: Invitation): void {
    if (this.#destroyed) {
      void invitation.reject({ statusCode: 480, reasonPhrase: 'Temporarily Unavailable' });
      return;
    }
    const callId = this.#ids.next();
    this.#manageSession(callId, 'incoming', invitation);
    const metadata = extractIncomingMetadata(invitation.request, this.#config.incomingHeaders);
    const remoteAddress = invitation.remoteIdentity.uri.user?.trim();
    const remoteIdentity =
      invitation.remoteIdentity.friendlyName.trim() ||
      remoteAddress ||
      invitation.remoteIdentity.uri.toString();

    this.#emit({
      type: 'incoming-call',
      callId,
      remoteIdentity,
      ...(remoteAddress === undefined || remoteAddress.length === 0 ? {} : { remoteAddress }),
      metadata,
    });
    if (this.#ringtone !== undefined) {
      void this.#ringtone.play(callId).catch(() => {
        if (this.#sessions.has(callId)) {
          this.#emit({ type: 'audio-unlock-required', callId });
        }
      });
    }
  }

  #assertEstablished(callId: string, operation: string): ManagedSession {
    this.#assertUsable();
    const managed = this.#requireSession(callId);
    if (
      managed.terminalEmitted ||
      !managed.established ||
      managed.session.state !== SessionState.Established
    ) {
      throw this.#invalidSessionAction(callId, operation);
    }
    return managed;
  }

  #attachMedia(callId: string, handler: unknown): void {
    if (!(handler instanceof Web.SessionDescriptionHandler)) {
      this.#emitError(
        new MiCallError('CALL_FAILED', 'SIP.js returned an unsupported media handler.', {
          recoverable: false,
          callId,
        }),
      );
      return;
    }
    this.#media.attach(callId, handler);
  }

  #emitMediaDevices(): void {
    const selection = this.#media.getSelection();
    this.#emit({
      type: 'media-devices',
      devices: this.#lastDevices,
      ...(selection.audioInputId === undefined
        ? {}
        : { selectedAudioInputId: selection.audioInputId }),
      ...(selection.callAudioOutputId === undefined
        ? {}
        : { selectedCallAudioOutputId: selection.callAudioOutputId }),
      ...(this.#selectedRingtoneOutputId === undefined
        ? {}
        : { selectedRingtoneOutputId: this.#selectedRingtoneOutputId }),
    });
  }

  #emitError(error: MiCallError): void {
    this.#emit({
      type: 'error',
      code: error.code,
      message: error.message,
      recoverable: error.recoverable,
      ...(error.callId === undefined ? {} : { callId: error.callId }),
      context: error.context,
    });
  }

  async #sendDtmfInfo(managed: ManagedSession, tone: string): Promise<void> {
    const callId = managed.callId;
    let cancelPending = (): void => undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let timeoutHandle: unknown = undefined;
        const finish = (outcome: () => void): void => {
          if (settled) {
            return;
          }
          settled = true;
          if (timeoutHandle !== undefined) {
            this.#scheduler.clear(timeoutHandle);
          }
          outcome();
        };
        cancelPending = (): void => finish(resolve);
        managed.controlAborters.add(cancelPending);
        timeoutHandle = this.#scheduler.set(DTMF_INFO_TIMEOUT_MS, () => {
          finish(() =>
            reject(
              new MiCallError('DTMF_UNSUPPORTED', 'SIP INFO DTMF timed out.', {
                recoverable: true,
                callId,
                context: { reason: 'timeout' },
              }),
            ),
          );
        });
        void managed.session
          .info({
            requestOptions: {
              body: {
                contentDisposition: 'render',
                contentType: 'application/dtmf-relay',
                content: `Signal=${tone}\r\nDuration=160`,
              },
            },
            requestDelegate: {
              onAccept: () => finish(resolve),
              onRedirect: (response) =>
                finish(() =>
                  reject(
                    new MiCallError('DTMF_UNSUPPORTED', 'SIP INFO DTMF was redirected.', {
                      recoverable: true,
                      callId,
                      context: { statusCode: response.message.statusCode ?? 0 },
                    }),
                  ),
                ),
              onReject: (response) =>
                finish(() =>
                  reject(
                    new MiCallError('DTMF_UNSUPPORTED', 'Remote peer rejected SIP INFO DTMF.', {
                      recoverable: true,
                      callId,
                      context: { statusCode: response.message.statusCode ?? 0 },
                    }),
                  ),
                ),
            },
          })
          .catch((error: unknown) => {
            finish(() =>
              reject(
                new MiCallError('DTMF_UNSUPPORTED', 'Unable to send SIP INFO DTMF.', {
                  recoverable: true,
                  callId,
                  cause: error,
                }),
              ),
            );
          });
      });
    } finally {
      managed.controlAborters.delete(cancelPending);
    }
  }

  async #completeTransfer(
    managed: ManagedSession,
    destination: string,
    generation: number,
  ): Promise<void> {
    if (managed.terminalEmitted || generation !== managed.controlGeneration) {
      return;
    }
    this.#emit({
      type: 'transfer-state',
      callId: managed.callId,
      destination,
      state: 'completed',
    });
    managed.localEndReason = 'transferred';
    try {
      await managed.session.bye();
    } catch (error) {
      this.#emitError(
        new MiCallError('CALL_FAILED', 'Transfer succeeded but SIP BYE could not be sent.', {
          recoverable: false,
          callId: managed.callId,
          cause: error,
        }),
      );
    } finally {
      this.#emitEnded(managed, 'transferred');
    }
  }

  #manageSession(
    callId: string,
    direction: 'incoming' | 'outgoing',
    session: Session,
  ): ManagedSession {
    const managed: ManagedSession = {
      callId,
      direction,
      session,
      established: false,
      terminalEmitted: false,
      localEndReason: undefined,
      timeoutHandle: undefined,
      holdInFlight: false,
      transferInFlight: false,
      controlGeneration: 0,
      controlAborters: new Set(),
      stateListener: (state) => {
        this.#handleSessionState(managed, state);
      },
    };
    this.#sessions.set(callId, managed);
    session.stateChange.addListener(managed.stateListener);
    session.delegate = {
      ...session.delegate,
      onBye: () => {
        this.#emitEnded(managed, 'remote-hangup');
      },
      onCancel: () => {
        this.#emitEnded(managed, 'remote-cancel');
      },
      onSessionDescriptionHandler: (handler) => {
        this.#attachMedia(managed.callId, handler);
      },
      onInvite: (request) => {
        const body = request.body ?? '';
        const remoteHold = /a=(?:sendonly|inactive)/i.test(body);
        this.#emit({ type: 'call-properties', callId: managed.callId, remoteHold });
      },
    };
    if (session.sessionDescriptionHandler !== undefined) {
      this.#attachMedia(callId, session.sessionDescriptionHandler);
    }
    return managed;
  }

  #handleSessionState(managed: ManagedSession, state: SessionState): void {
    if (managed.terminalEmitted || this.#destroyed) {
      return;
    }
    if (state === SessionState.Established) {
      managed.established = true;
      this.#clearCallTimeout(managed);
      this.#ringtone?.stop(managed.callId);
      this.#emit({ type: 'call-state', callId: managed.callId, state: 'establishing' });
      this.#emit({ type: 'call-state', callId: managed.callId, state: 'active' });
      return;
    }
    if (state === SessionState.Terminated) {
      const reason =
        managed.localEndReason ??
        (managed.established
          ? 'remote-hangup'
          : managed.direction === 'incoming'
            ? 'remote-cancel'
            : 'failed');
      this.#emitEnded(managed, reason);
    }
  }

  async #timeoutOutgoingCall(managed: ManagedSession): Promise<void> {
    if (managed.terminalEmitted || managed.established || !(managed.session instanceof Inviter)) {
      return;
    }
    managed.localEndReason = 'no-answer';
    try {
      await managed.session.cancel();
    } catch (error) {
      this.#logger?.log('warn', 'Timed-out SIP INVITE could not be cancelled.', {
        callId: managed.callId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      this.#emitEnded(managed, 'failed');
    }
  }

  #emitEnded(managed: ManagedSession, reason: CallEndReason, sipStatusCode?: number): void {
    if (managed.terminalEmitted) {
      return;
    }
    managed.terminalEmitted = true;
    managed.controlGeneration += 1;
    this.#cancelControlTransactions(managed);
    this.#clearCallTimeout(managed);
    this.#ringtone?.stop(managed.callId);
    this.#media.release(managed.callId);
    managed.session.stateChange.removeListener(managed.stateListener);
    this.#sessions.delete(managed.callId);
    this.#emit({
      type: 'call-ended',
      callId: managed.callId,
      reason,
      ...(sipStatusCode === undefined ? {} : { sipStatusCode }),
    });
    const hangupPlayback = this.#ringtone?.playHangup?.();
    if (hangupPlayback !== undefined) {
      void hangupPlayback.catch((error: unknown) => {
        this.#logger?.log('warn', 'Hangup tone could not be played.', {
          callId: managed.callId,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      });
    }
  }

  #clearCallTimeout(managed: ManagedSession): void {
    if (managed.timeoutHandle !== undefined) {
      this.#scheduler.clear(managed.timeoutHandle);
      managed.timeoutHandle = undefined;
    }
  }

  #cancelControlTransactions(managed: ManagedSession): void {
    for (const abort of [...managed.controlAborters]) {
      abort();
    }
    managed.controlAborters.clear();
  }

  #parseDestination(destination: string): URI {
    const trimmed = destination.trim();
    const directUri = trimmed.startsWith('sip:') || trimmed.startsWith('sips:');
    const accountUri = UserAgent.makeURI(this.#config.uri);
    if (accountUri === undefined) {
      throw new MiCallError('INVALID_CONFIG', 'Configured SIP URI is invalid.');
    }
    if (!directUri && !/^[A-Za-z0-9_.!~*'()%+-]+$/.test(trimmed)) {
      throw new MiCallError('INVALID_DESTINATION', 'Destination contains unsupported characters.');
    }
    const target = UserAgent.makeURI(directUri ? trimmed : `sip:${trimmed}@${accountUri.host}`);
    if (target === undefined) {
      throw new MiCallError(
        'INVALID_DESTINATION',
        'Destination could not be converted to a SIP URI.',
      );
    }
    return target;
  }

  #requireSession(callId: string): ManagedSession {
    const managed = this.#sessions.get(callId);
    if (managed === undefined) {
      throw new MiCallError('CALL_NOT_FOUND', `Call '${callId}' was not found.`, {
        recoverable: true,
        callId,
      });
    }
    return managed;
  }

  #invalidSessionAction(callId: string, operation: string): MiCallError {
    return new MiCallError('INVALID_CALL_STATE', `Cannot ${operation} call '${callId}'.`, {
      recoverable: true,
      callId,
    });
  }

  #assertUsable(): void {
    if (this.#destroyed) {
      throw new MiCallError('CLIENT_DESTROYED', 'SIP signaling adapter has been destroyed.');
    }
  }

  #emit(event: SignalingEvent): void {
    if (this.#destroyed) {
      return;
    }
    for (const listener of [...this.#listeners]) {
      listener(event);
    }
  }
}

export function mapRejectedInvite(statusCode: number | undefined): CallEndReason {
  switch (statusCode) {
    case 408:
      return 'no-answer';
    case 486:
      return 'busy';
    case 603:
      return 'declined';
    default:
      return 'failed';
  }
}

export function parseNotifyStatus(notification: Notification): number | undefined {
  const match = /SIP\/2\.0\s+(\d{3})/i.exec(notification.request.body);
  if (match?.[1] === undefined) {
    return undefined;
  }
  return Number(match[1]);
}

function isMediaPermissionError(error: unknown): boolean {
  if (error instanceof MiCallError) {
    return error.code === 'MEDIA_PERMISSION_DENIED' || error.code === 'MEDIA_DEVICE_NOT_FOUND';
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === 'NotAllowedError' ||
    error.name === 'SecurityError' ||
    error.name === 'NotFoundError' ||
    error.name === 'OverconstrainedError'
  );
}
