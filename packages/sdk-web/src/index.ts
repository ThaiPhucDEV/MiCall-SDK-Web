import {
  MiCallClient,
  MiCallError,
  StructuredLogger,
  TypedEventEmitter,
  type AudioUnlockResult,
  type CallSnapshot,
  type DiagnosticReport,
  type IdGenerator,
  type LogEntry,
  type LoggerPort,
  type MiCallCapabilities,
  type MiCallConfig,
  type MiCallConsumerClient,
  type MiCallEventMap,
  type MiCallPublicSnapshot,
  type OutgoingCallRequest,
  type Unsubscribe,
} from '@micall/core';
import {
  SipJsSignaling,
  observePageLifecycle,
  type PageLifecycleTarget,
} from '@micall/sipjs-browser';
import type { CallScreenHandle, CallScreenSlotName, CallScreenTheme } from '@micall/call-screen';

export interface MiCallUIConfig {
  readonly defaultCallScreen?: boolean;
  readonly mountTarget?: ParentNode;
  readonly tagName?: string;
  readonly theme?: CallScreenTheme;
  readonly slots?: Readonly<Partial<Record<CallScreenSlotName, Node | string>>>;
  readonly loggingEnabled?: boolean;
}

export interface MiCallSDKConfig extends MiCallConfig {
  readonly ringtoneUrl?: string;
  readonly ui?: MiCallUIConfig;
}

export type MiCallSnapshot = MiCallPublicSnapshot;

export const MICALL_DOM_EVENT_NAMES: Readonly<Record<keyof MiCallEventMap, string>> = {
  transportStateChanged: 'micall:transport-state-changed',
  registrationStateChanged: 'micall:registration-state-changed',
  incomingCall: 'micall:incoming-call',
  incomingCallRejected: 'micall:incoming-call-rejected',
  callStateChanged: 'micall:call-state-changed',
  callEnded: 'micall:call-ended',
  error: 'micall:error',
  audioUnlockRequired: 'micall:audio-unlock-required',
  mediaDevicesChanged: 'micall:media-devices-changed',
  transferStateChanged: 'micall:transfer-state-changed',
  callNetworkMetricsChanged: 'micall:call-network-metrics-changed',
};

class WebCryptoIdGenerator implements IdGenerator {
  public next(): string {
    if (typeof globalThis.crypto?.randomUUID !== 'function') {
      throw new MiCallError('INTERNAL_ERROR', 'crypto.randomUUID() is required.');
    }
    return globalThis.crypto.randomUUID();
  }
}

export class MiCallBrowserSDK implements MiCallConsumerClient {
  public readonly events: EventTarget;
  readonly #client: MiCallClient;
  readonly #signaling: SipJsSignaling;
  readonly #typedEvents: TypedEventEmitter<MiCallEventMap>;
  readonly #subscriptions: Unsubscribe[] = [];
  readonly #logger: StructuredLogger | undefined;
  readonly #autoRegister: boolean;
  #snapshot: MiCallSnapshot;
  #callScreen: CallScreenHandle | undefined;
  #stopLifecycle: (() => void) | undefined;
  #destroyed = false;

  public constructor(config: MiCallSDKConfig) {
    assertSecureBrowserContext();
    this.events = new EventTarget();
    this.#autoRegister = config.registration?.autoRegister ?? true;
    this.#logger = createStructuredLogger(config);
    const logger: LoggerPort | undefined = config.logging?.customLogger ?? this.#logger;
    this.#typedEvents = new TypedEventEmitter<MiCallEventMap>((error) => {
      logger?.log('warn', 'A browser SDK event listener threw an exception.', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    });
    const ids = new WebCryptoIdGenerator();
    this.#signaling = new SipJsSignaling(
      {
        ...config.sip,
        ...(config.incomingHeaders === undefined
          ? {}
          : { incomingHeaders: config.incomingHeaders }),
        ...(config.outgoingCallTimeoutMs === undefined
          ? {}
          : { outgoingCallTimeoutMs: config.outgoingCallTimeoutMs }),
        ...(config.ringtoneUrl === undefined ? {} : { ringtoneUrl: config.ringtoneUrl }),
        ...(config.rtc?.iceServers === undefined
          ? {}
          : {
              iceServers: config.rtc.iceServers.map((server) => ({
                ...server,
                urls: typeof server.urls === 'string' ? server.urls : [...server.urls],
              })),
            }),
      },
      {
        ids,
        ...(logger === undefined ? {} : { logger }),
      },
    );
    this.#client = new MiCallClient({
      signaling: this.#signaling,
      clock: { now: Date.now },
      ids,
      ...(logger === undefined ? {} : { logger }),
    });
    this.#snapshot = this.#createSnapshot();
    this.#bindEvents();

    if (typeof globalThis.document !== 'undefined') {
      this.#stopLifecycle = observePageLifecycle({
        document: globalThis.document as PageLifecycleTarget,
        resume: () => {
          this.#signaling.resume();
        },
        ...(logger === undefined ? {} : { logger }),
      });
    }
  }

  public on<EventName extends keyof MiCallEventMap>(
    eventName: EventName,
    listener: (payload: MiCallEventMap[EventName]) => void,
  ): Unsubscribe {
    return this.#typedEvents.on(eventName, listener);
  }

  public async start(): Promise<void> {
    await this.#client.start();
    if (this.#autoRegister) {
      await this.#client.register();
    }
  }

  public register(): Promise<void> {
    return this.#client.register();
  }

  public unregister(): Promise<void> {
    return this.#client.unregister();
  }

  public async makeCall(
    destination: string,
    options: Omit<OutgoingCallRequest, 'destination'> = {},
  ): Promise<CallSnapshot> {
    const call = await this.#client.makeCall({ destination, ...options });
    this.#snapshot = this.#createSnapshot();
    this.#callScreen?.show();
    return call;
  }

  public answerCall(callId: string): Promise<void> {
    return this.#client.answerCall(callId);
  }

  public rejectCall(callId: string): Promise<void> {
    return this.#client.rejectCall(callId);
  }

  public hangupCall(callId: string): Promise<void> {
    return this.#client.hangupCall(callId);
  }

  public setMuted(callId: string, muted: boolean): Promise<void> {
    return this.#client.setMuted(callId, muted);
  }

  public setHold(callId: string, held: boolean): Promise<void> {
    return this.#client.setHold(callId, held);
  }

  public sendDtmf(callId: string, tones: string): Promise<void> {
    return this.#client.sendDtmf(callId, tones);
  }

  public blindTransfer(callId: string, destination: string): Promise<void> {
    return this.#client.blindTransfer(callId, destination);
  }

  public selectAudioInput(deviceId: string): Promise<void> {
    return this.#client.selectAudioInput(deviceId);
  }

  public selectCallAudioOutput(deviceId: string): Promise<void> {
    return this.#client.selectCallAudioOutput(deviceId);
  }

  public selectRingtoneOutput(deviceId: string): Promise<void> {
    return this.#client.selectRingtoneOutput(deviceId);
  }

  public unlockAudio(): Promise<AudioUnlockResult> {
    return this.#client.unlockAudio();
  }

  public getCapabilities(): MiCallCapabilities {
    return this.#client.getCapabilities();
  }

  public getSnapshot(): MiCallSnapshot {
    return this.#snapshot;
  }

  public getDiagnostics(): DiagnosticReport | undefined {
    return this.#logger?.exportDiagnostics();
  }

  public getRecentLogs(count?: number): readonly LogEntry[] {
    const logs = this.#logger?.getRecentLogs() ?? [];
    return count === undefined ? logs : Object.freeze(logs.slice(-Math.max(0, count)));
  }

  public exportDiagnosticReport(): string {
    return JSON.stringify(
      this.#logger?.exportDiagnostics() ?? Object.freeze({ generatedAt: Date.now(), logs: [] }),
      undefined,
      2,
    );
  }

  public attachCallScreen(handle: CallScreenHandle): CallScreenHandle {
    if (this.#callScreen !== undefined) {
      if (this.#callScreen !== handle) {
        handle.destroy();
      }
      return this.#callScreen;
    }
    this.#callScreen = handle;
    return handle;
  }

  public getCallScreen(): CallScreenHandle | undefined {
    return this.#callScreen;
  }

  public stop(): Promise<void> {
    return this.#client.stop();
  }

  public async destroy(): Promise<void> {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    this.#callScreen?.destroy();
    this.#callScreen = undefined;
    this.#stopLifecycle?.();
    this.#stopLifecycle = undefined;
    for (const unsubscribe of this.#subscriptions.splice(0)) {
      unsubscribe();
    }
    this.#typedEvents.clear();
    await this.#client.destroy();
  }

  #bindEvents(): void {
    for (const eventName of Object.keys(MICALL_DOM_EVENT_NAMES) as (keyof MiCallEventMap)[]) {
      this.#bindEvent(eventName);
    }
  }

  #bindEvent<EventName extends keyof MiCallEventMap>(eventName: EventName): void {
    this.#subscriptions.push(
      this.#client.on(eventName, (payload) => {
        this.#snapshot = this.#createSnapshot();
        this.#typedEvents.emit(eventName, payload);
        this.events.dispatchEvent(
          new CustomEvent(MICALL_DOM_EVENT_NAMES[eventName], {
            detail: payload,
          }),
        );
      }),
    );
  }

  #createSnapshot(): MiCallSnapshot {
    return Object.freeze({
      transportState: this.#client.transportState,
      registrationState: this.#client.registrationState,
      calls: this.#client.getCalls(),
    });
  }
}

function createStructuredLogger(config: MiCallSDKConfig): StructuredLogger | undefined {
  if (config.logging?.level === 'none' || config.logging?.enableDiagnosticsBuffer === false) {
    return undefined;
  }
  return new StructuredLogger({
    scope: 'SDK',
    minimumLevel: config.logging?.level ?? 'info',
    capacity: config.logging?.maxBufferSize ?? 200,
  });
}

function assertSecureBrowserContext(): void {
  if (typeof globalThis.location === 'undefined') {
    return;
  }
  const { hostname, protocol } = globalThis.location;
  const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  if (protocol !== 'https:' && !isLocalhost) {
    throw new MiCallError(
      'INVALID_CONFIG',
      'MiCall requires an HTTPS page in production. HTTP is only allowed on localhost.',
    );
  }
}

export function createBrowserClient(config: MiCallSDKConfig): MiCallBrowserSDK {
  return new MiCallBrowserSDK(config);
}

export async function createMiCallSDK(config: MiCallSDKConfig): Promise<MiCallBrowserSDK> {
  const sdk = createBrowserClient(config);
  if (config.ui?.defaultCallScreen !== true) {
    return sdk;
  }

  try {
    const { createCallScreen } = await import('@micall/call-screen');
    const handle = createCallScreen({
      client: sdk,
      ...(config.ui.tagName === undefined ? {} : { tagName: config.ui.tagName }),
      ...(config.ui.mountTarget === undefined ? {} : { mountTarget: config.ui.mountTarget }),
      ...(config.ui.theme === undefined ? {} : { theme: config.ui.theme }),
      ...(config.ui.loggingEnabled === undefined
        ? {}
        : { loggingEnabled: config.ui.loggingEnabled }),
    });
    for (const [slotName, content] of Object.entries(config.ui.slots ?? {})) {
      if (content !== undefined && (slotName === 'brand-logo' || slotName === 'footer')) {
        handle.setSlotContent(slotName, content);
      }
    }
    handle.mount();
    sdk.attachCallScreen(handle);
    return sdk;
  } catch (error) {
    await sdk.destroy();
    throw error;
  }
}

export * from '@micall/core';
export * from './login.js';
export type { CallScreenHandle, CallScreenSlotName, CallScreenTheme } from '@micall/call-screen';
