import {
  MiCallError,
  type AudioDeviceSnapshot,
  type CallNetworkQuality,
  type LoggerPort,
} from '@micall/core';
import type { Web } from 'sip.js';

const NETWORK_QUALITY_POLL_INTERVAL_MS = 3_000;
const GOOD_MAX_RTT_MS = 150;
const FAIR_MAX_RTT_MS = 300;
const GOOD_MAX_PACKET_LOSS_RATIO = 0.02;
const FAIR_MAX_PACKET_LOSS_RATIO = 0.05;
const BYTES_PER_KILOBYTE = 1_000;

export interface BrowserMediaDevices {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
  addEventListener(type: 'devicechange', listener: EventListener): void;
  removeEventListener(type: 'devicechange', listener: EventListener): void;
}

export interface BrowserMediaManagerOptions {
  readonly mediaDevices?: BrowserMediaDevices;
  readonly audioFactory?: () => HTMLAudioElement;
  readonly logger?: LoggerPort;
  readonly onAudioUnlockRequired?: (callId: string) => void;
  readonly onNetworkQualityChanged?: (
    callId: string,
    quality: CallNetworkQuality,
  ) => void;
  readonly onNetworkThroughputChanged?: (
    callId: string,
    kilobytesPerSecond: number,
  ) => void;
  readonly onDevicesChanged?: (
    devices: readonly AudioDeviceSnapshot[],
    selection: AudioDeviceSelection,
  ) => void;
  readonly onError?: (error: MiCallError) => void;
  readonly intervalScheduler?: IntervalScheduler;
}

export interface IntervalScheduler {
  set(callback: () => void, intervalMs: number): unknown;
  clear(handle: unknown): void;
}

export interface NetworkQualitySample {
  readonly roundTripTimeMs?: number;
  readonly packetLossRatio?: number;
}

export interface AudioDeviceSelection {
  readonly audioInputId?: string;
  readonly callAudioOutputId?: string;
}

interface ManagedMediaSession {
  readonly handler: Web.SessionDescriptionHandler;
  readonly remoteAudio: HTMLAudioElement;
  readonly remoteTrackListener: EventListener;
  qualityMonitorHandle?: unknown;
  qualitySampleInFlight: boolean;
  previousPacketCounters?: NetworkPacketCounters;
  previousTrafficCounters?: NetworkTrafficCounters;
  networkQuality: CallNetworkQuality;
}

interface NetworkPacketCounters {
  readonly received: number;
  readonly lost: number;
}

export interface NetworkTrafficCounters {
  readonly timestampMs: number;
  readonly bytesReceived: number;
  readonly bytesSent: number;
}

interface QualityStats extends RTCStats {
  readonly kind?: string;
  readonly mediaType?: string;
  readonly packetsLost?: number;
  readonly packetsReceived?: number;
  readonly bytesReceived?: number;
  readonly bytesSent?: number;
  readonly currentRoundTripTime?: number;
  readonly roundTripTime?: number;
  readonly selectedCandidatePairId?: string;
  readonly state?: string;
  readonly nominated?: boolean;
  readonly selected?: boolean;
}

class BrowserIntervalScheduler implements IntervalScheduler {
  public set(callback: () => void, intervalMs: number): unknown {
    return globalThis.setInterval(callback, intervalMs);
  }

  public clear(handle: unknown): void {
    globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>);
  }
}

export class BrowserMediaManager {
  readonly #mediaDevices: BrowserMediaDevices | undefined;
  readonly #audioFactory: () => HTMLAudioElement;
  readonly #logger: LoggerPort | undefined;
  readonly #onAudioUnlockRequired: ((callId: string) => void) | undefined;
  readonly #onNetworkQualityChanged:
    | ((callId: string, quality: CallNetworkQuality) => void)
    | undefined;
  readonly #onNetworkThroughputChanged:
    | ((callId: string, kilobytesPerSecond: number) => void)
    | undefined;
  readonly #onDevicesChanged:
    | ((devices: readonly AudioDeviceSnapshot[], selection: AudioDeviceSelection) => void)
    | undefined;
  readonly #onError: ((error: MiCallError) => void) | undefined;
  readonly #intervalScheduler: IntervalScheduler;
  readonly #sessions = new Map<string, ManagedMediaSession>();
  readonly #ownedTracks = new Set<MediaStreamTrack>();
  readonly #deviceChangeListener: EventListener;
  #selectedAudioInputId: string | undefined;
  #selectedCallAudioOutputId: string | undefined;
  #started = false;
  #destroyed = false;

  public constructor(options: BrowserMediaManagerOptions = {}) {
    this.#mediaDevices = options.mediaDevices ?? globalThis.navigator?.mediaDevices;
    this.#audioFactory = options.audioFactory ?? (() => new Audio());
    this.#logger = options.logger;
    this.#onAudioUnlockRequired = options.onAudioUnlockRequired;
    this.#onNetworkQualityChanged = options.onNetworkQualityChanged;
    this.#onNetworkThroughputChanged = options.onNetworkThroughputChanged;
    this.#onDevicesChanged = options.onDevicesChanged;
    this.#onError = options.onError;
    this.#intervalScheduler = options.intervalScheduler ?? new BrowserIntervalScheduler();
    this.#deviceChangeListener = (): void => {
      void this.#handleDeviceChange().catch((error: unknown) => {
        this.#onError?.(toMediaDeviceError(error, 'Unable to refresh browser audio devices.'));
      });
    };
  }

  public readonly mediaStreamFactory = async (
    constraints: MediaStreamConstraints,
  ): Promise<MediaStream> => {
    const mediaDevices = this.#requireMediaDevices();
    const audio =
      this.#selectedAudioInputId === undefined
        ? constraints.audio
        : { deviceId: { exact: this.#selectedAudioInputId } };
    try {
      const stream = await mediaDevices.getUserMedia({
        ...constraints,
        audio: audio ?? true,
        video: false,
      });
      for (const track of stream.getTracks()) {
        this.#ownedTracks.add(track);
      }
      return stream;
    } catch (error) {
      throw mapMediaAcquisitionError(error);
    }
  };

  public start(): void {
    if (this.#started || this.#destroyed || this.#mediaDevices === undefined) {
      return;
    }
    this.#started = true;
    this.#mediaDevices.addEventListener('devicechange', this.#deviceChangeListener);
    void this.refreshDevices().catch((error: unknown) => {
      this.#onError?.(toMediaDeviceError(error, 'Unable to enumerate browser audio devices.'));
    });
  }

  public attach(callId: string, handler: Web.SessionDescriptionHandler): void {
    if (this.#destroyed) {
      return;
    }
    if (this.#sessions.get(callId)?.handler === handler) {
      return;
    }
    this.release(callId);
    for (const track of handler.localMediaStream.getTracks()) {
      this.#ownedTracks.add(track);
    }

    const remoteAudio = this.#audioFactory();
    remoteAudio.autoplay = true;
    remoteAudio.srcObject = handler.remoteMediaStream;
    const remoteTrackListener: EventListener = () => {
      void this.#playRemoteAudio(callId, remoteAudio);
    };
    const managed: ManagedMediaSession = {
      handler,
      remoteAudio,
      remoteTrackListener,
      qualitySampleInFlight: false,
      networkQuality: 'unknown',
    };
    this.#sessions.set(callId, managed);
    if (this.#selectedCallAudioOutputId !== undefined) {
      void this.#setSinkId(remoteAudio, this.#selectedCallAudioOutputId, 'call').catch(
        (error: unknown) => {
          this.#onError?.(
            toMediaDeviceError(error, 'Unable to apply the selected call output device.'),
          );
        },
      );
    }
    void this.#playRemoteAudio(callId, remoteAudio);
    handler.remoteMediaStream.addEventListener('addtrack', remoteTrackListener);
    this.#startNetworkQualityMonitoring(callId, managed);
  }

  public async setMuted(callId: string, muted: boolean): Promise<void> {
    const managed = this.#requireSession(callId);
    const audioTracks = managed.handler.localMediaStream.getAudioTracks();
    if (audioTracks.length === 0) {
      throw new MiCallError('MEDIA_DEVICE_NOT_FOUND', 'No outbound audio track is available.', {
        recoverable: true,
        callId,
      });
    }
    for (const track of audioTracks) {
      track.enabled = !muted;
    }
  }

  public async selectAudioInput(deviceId: string): Promise<void> {
    const mediaDevices = this.#requireMediaDevices();
    await this.#assertDeviceExists(deviceId, 'audioinput');
    if (this.#selectedAudioInputId === deviceId) {
      return;
    }
    if (this.#sessions.size === 0) {
      this.#selectedAudioInputId = deviceId;
      await this.refreshDevices();
      return;
    }

    let replacementStream: MediaStream;
    try {
      replacementStream = await mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId } },
        video: false,
      });
    } catch (error) {
      throw mapMediaAcquisitionError(error);
    }
    const replacementTrack = replacementStream.getAudioTracks()[0];
    if (replacementTrack === undefined) {
      stopStream(replacementStream);
      throw new MiCallError('MEDIA_DEVICE_NOT_FOUND', 'Selected microphone has no audio track.', {
        recoverable: true,
      });
    }

    try {
      for (const managed of this.#sessions.values()) {
        const sender = managed.handler.peerConnection
          ?.getSenders()
          .find((candidate) => candidate.track?.kind === 'audio');
        if (sender === undefined) {
          throw new MiCallError('MEDIA_DEVICE_NOT_FOUND', 'Outbound audio sender is unavailable.', {
            recoverable: true,
          });
        }
        const previousTracks = managed.handler.localMediaStream.getAudioTracks();
        replacementTrack.enabled = previousTracks[0]?.enabled ?? true;
        await sender.replaceTrack(replacementTrack);
        for (const previousTrack of previousTracks) {
          managed.handler.localMediaStream.removeTrack(previousTrack);
          this.#stopOwnedTrack(previousTrack);
        }
        managed.handler.localMediaStream.addTrack(replacementTrack);
      }
    } catch (error) {
      stopStream(replacementStream);
      if (error instanceof MiCallError) {
        throw error;
      }
      throw new MiCallError('CALL_FAILED', 'Unable to replace the outbound microphone track.', {
        recoverable: true,
        cause: error,
      });
    }

    this.#ownedTracks.add(replacementTrack);
    this.#selectedAudioInputId = deviceId;
    await this.refreshDevices();
  }

  public async selectCallAudioOutput(deviceId: string): Promise<void> {
    await this.#assertDeviceExists(deviceId, 'audiooutput');
    const targets = [...this.#sessions.values()].map((managed) => managed.remoteAudio);
    if (targets.length === 0) {
      const probe = this.#audioFactory();
      await this.#setSinkId(probe, deviceId, 'call');
    } else {
      await Promise.all(targets.map(async (audio) => this.#setSinkId(audio, deviceId, 'call')));
    }
    this.#selectedCallAudioOutputId = deviceId;
    await this.refreshDevices();
  }

  public async unlockAudio(): Promise<boolean> {
    if (this.#sessions.size === 0) {
      return false;
    }
    const results = await Promise.all(
      [...this.#sessions.values()].map(async ({ remoteAudio }) => {
        try {
          await remoteAudio.play();
          return true;
        } catch {
          return false;
        }
      }),
    );
    return results.every(Boolean);
  }

  public hasAttachedMedia(): boolean {
    return this.#sessions.size > 0;
  }

  public getCapabilities(): { readonly audioOutputSelection: boolean; readonly rtpDtmf: boolean } {
    const audio = this.#audioFactory();
    const rtpDtmf = [...this.#sessions.values()].some(({ handler }) =>
      handler.peerConnection
        ?.getSenders()
        .some((sender) => sender.track?.kind === 'audio' && sender.dtmf !== null),
    );
    return Object.freeze({
      audioOutputSelection: typeof audio.setSinkId === 'function',
      rtpDtmf,
    });
  }

  public getSelection(): AudioDeviceSelection {
    return this.#selection();
  }

  public async refreshDevices(): Promise<readonly AudioDeviceSnapshot[]> {
    if (this.#mediaDevices === undefined || this.#destroyed) {
      return Object.freeze([]);
    }
    const devices = Object.freeze(
      (await this.#mediaDevices.enumerateDevices())
        .filter(
          (device): device is MediaDeviceInfo & { kind: 'audioinput' | 'audiooutput' } =>
            device.kind === 'audioinput' || device.kind === 'audiooutput',
        )
        .map((device) =>
          Object.freeze({
            deviceId: device.deviceId,
            groupId: device.groupId,
            kind: device.kind,
            label: device.label,
          }),
        ),
    );
    this.#onDevicesChanged?.(devices, this.#selection());
    return devices;
  }

  public release(callId: string): void {
    const managed = this.#sessions.get(callId);
    if (managed === undefined) {
      return;
    }
    if (managed.qualityMonitorHandle !== undefined) {
      this.#intervalScheduler.clear(managed.qualityMonitorHandle);
    }
    managed.remoteAudio.pause();
    managed.remoteAudio.srcObject = null;
    managed.handler.remoteMediaStream.removeEventListener('addtrack', managed.remoteTrackListener);
    for (const track of managed.handler.localMediaStream.getTracks()) {
      this.#stopOwnedTrack(track);
    }
    this.#sessions.delete(callId);
  }

  public destroy(): void {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    if (this.#started) {
      this.#mediaDevices?.removeEventListener('devicechange', this.#deviceChangeListener);
    }
    for (const callId of [...this.#sessions.keys()]) {
      this.release(callId);
    }
    for (const track of [...this.#ownedTracks]) {
      this.#stopOwnedTrack(track);
    }
  }

  async #handleDeviceChange(): Promise<void> {
    const devices = await this.refreshDevices();
    let selectionChanged = false;
    if (
      this.#selectedAudioInputId !== undefined &&
      !devices.some(
        (device) => device.kind === 'audioinput' && device.deviceId === this.#selectedAudioInputId,
      )
    ) {
      this.#selectedAudioInputId = undefined;
      selectionChanged = true;
      this.#onError?.(
        new MiCallError(
          'MEDIA_DEVICE_NOT_FOUND',
          'Selected microphone was disconnected; falling back to the default device.',
          { recoverable: true },
        ),
      );
      if (this.#sessions.size > 0) {
        try {
          await this.#replaceWithDefaultInput();
        } catch (error) {
          this.#logger?.log('warn', 'Default microphone fallback failed.', {
            errorName: error instanceof Error ? error.name : 'UnknownError',
          });
          this.#onError?.(
            error instanceof MiCallError
              ? error
              : new MiCallError('CALL_FAILED', 'Default microphone fallback failed.', {
                  recoverable: true,
                  cause: error,
                }),
          );
        }
      }
    }
    if (
      this.#selectedCallAudioOutputId !== undefined &&
      !devices.some(
        (device) =>
          device.kind === 'audiooutput' && device.deviceId === this.#selectedCallAudioOutputId,
      )
    ) {
      this.#selectedCallAudioOutputId = undefined;
      selectionChanged = true;
      this.#onError?.(
        new MiCallError(
          'MEDIA_DEVICE_NOT_FOUND',
          'Selected call output was disconnected; falling back to the default device.',
          { recoverable: true },
        ),
      );
      for (const managed of this.#sessions.values()) {
        if (typeof managed.remoteAudio.setSinkId === 'function') {
          void managed.remoteAudio.setSinkId('default').catch(() => undefined);
        }
      }
    }
    if (selectionChanged) {
      this.#onDevicesChanged?.(devices, this.#selection());
    }
  }

  async #replaceWithDefaultInput(): Promise<void> {
    const mediaDevices = this.#requireMediaDevices();
    let stream: MediaStream;
    try {
      stream = await mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (error) {
      throw mapMediaAcquisitionError(error);
    }
    const track = stream.getAudioTracks()[0];
    if (track === undefined) {
      stopStream(stream);
      throw new MiCallError('MEDIA_DEVICE_NOT_FOUND', 'Default microphone is unavailable.');
    }
    try {
      for (const managed of this.#sessions.values()) {
        const sender = managed.handler.peerConnection
          ?.getSenders()
          .find((candidate) => candidate.track?.kind === 'audio');
        if (sender === undefined) {
          throw new MiCallError('MEDIA_DEVICE_NOT_FOUND', 'Outbound audio sender is unavailable.');
        }
        const previousTracks = managed.handler.localMediaStream.getAudioTracks();
        track.enabled = previousTracks[0]?.enabled ?? true;
        await sender.replaceTrack(track);
        for (const previous of previousTracks) {
          managed.handler.localMediaStream.removeTrack(previous);
          this.#stopOwnedTrack(previous);
        }
        managed.handler.localMediaStream.addTrack(track);
      }
      this.#ownedTracks.add(track);
    } catch (error) {
      track.stop();
      throw error;
    }
  }

  async #assertDeviceExists(deviceId: string, kind: 'audioinput' | 'audiooutput'): Promise<void> {
    const mediaDevices = this.#requireMediaDevices();
    let devices: MediaDeviceInfo[];
    try {
      devices = await mediaDevices.enumerateDevices();
    } catch (error) {
      throw toMediaDeviceError(error, 'Unable to enumerate browser audio devices.');
    }
    if (!devices.some((device) => device.kind === kind && device.deviceId === deviceId)) {
      throw new MiCallError('MEDIA_DEVICE_NOT_FOUND', `Audio device '${deviceId}' was not found.`, {
        recoverable: true,
      });
    }
  }

  async #setSinkId(audio: HTMLAudioElement, deviceId: string, outputKind: string): Promise<void> {
    if (typeof audio.setSinkId !== 'function') {
      throw new MiCallError(
        'AUDIO_OUTPUT_UNSUPPORTED',
        `This browser does not support ${outputKind} output selection.`,
        { recoverable: true },
      );
    }
    try {
      await audio.setSinkId(deviceId);
    } catch (error) {
      throw toMediaDeviceError(error, `Unable to select the ${outputKind} output device.`);
    }
  }

  async #playRemoteAudio(callId: string, audio: HTMLAudioElement): Promise<void> {
    try {
      await audio.play();
    } catch {
      this.#onAudioUnlockRequired?.(callId);
    }
  }

  #startNetworkQualityMonitoring(callId: string, managed: ManagedMediaSession): void {
    const peerConnection = managed.handler.peerConnection;
    if (peerConnection === undefined || typeof peerConnection.getStats !== 'function') {
      return;
    }
    void this.#refreshNetworkQuality(callId, managed, peerConnection);
    managed.qualityMonitorHandle = this.#intervalScheduler.set(() => {
      void this.#refreshNetworkQuality(callId, managed, peerConnection);
    }, NETWORK_QUALITY_POLL_INTERVAL_MS);
  }

  async #refreshNetworkQuality(
    callId: string,
    managed: ManagedMediaSession,
    peerConnection: RTCPeerConnection,
  ): Promise<void> {
    if (managed.qualitySampleInFlight) {
      return;
    }
    managed.qualitySampleInFlight = true;
    try {
      const stats = await peerConnection.getStats();
      if (this.#sessions.get(callId) !== managed) {
        return;
      }
      const measurement = readNetworkMeasurement(stats);
      const packetLossRatio = calculatePacketLossRatio(
        measurement.packetCounters,
        managed.previousPacketCounters,
      );
      const kilobytesPerSecond = calculateNetworkKilobytesPerSecond(
        measurement.trafficCounters,
        managed.previousTrafficCounters,
      );
      managed.previousPacketCounters = measurement.packetCounters;
      managed.previousTrafficCounters = measurement.trafficCounters;
      const quality = classifyNetworkQuality({
        ...(measurement.roundTripTimeMs === undefined
          ? {}
          : { roundTripTimeMs: measurement.roundTripTimeMs }),
        ...(packetLossRatio === undefined ? {} : { packetLossRatio }),
      });
      if (quality !== managed.networkQuality) {
        managed.networkQuality = quality;
        this.#onNetworkQualityChanged?.(callId, quality);
      }
      if (kilobytesPerSecond !== undefined) {
        this.#onNetworkThroughputChanged?.(callId, kilobytesPerSecond);
      }
    } catch (error) {
      this.#logger?.log('debug', 'WebRTC network quality stats are unavailable.', {
        callId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    } finally {
      managed.qualitySampleInFlight = false;
    }
  }

  #selection(): AudioDeviceSelection {
    return Object.freeze({
      ...(this.#selectedAudioInputId === undefined
        ? {}
        : { audioInputId: this.#selectedAudioInputId }),
      ...(this.#selectedCallAudioOutputId === undefined
        ? {}
        : { callAudioOutputId: this.#selectedCallAudioOutputId }),
    });
  }

  #requireSession(callId: string): ManagedMediaSession {
    const managed = this.#sessions.get(callId);
    if (managed === undefined) {
      throw new MiCallError('CALL_NOT_FOUND', `Media session '${callId}' was not found.`, {
        recoverable: true,
        callId,
      });
    }
    return managed;
  }

  #stopOwnedTrack(track: MediaStreamTrack): void {
    if (!this.#ownedTracks.delete(track)) {
      return;
    }
    track.stop();
  }

  #requireMediaDevices(): BrowserMediaDevices {
    if (this.#destroyed) {
      throw new MiCallError('CLIENT_DESTROYED', 'Browser media manager has been destroyed.');
    }
    if (this.#mediaDevices === undefined) {
      throw new MiCallError('MEDIA_DEVICE_NOT_FOUND', 'Browser media devices API is unavailable.');
    }
    return this.#mediaDevices;
  }
}

export function classifyNetworkQuality(sample: NetworkQualitySample): CallNetworkQuality {
  const { roundTripTimeMs, packetLossRatio } = sample;
  if (roundTripTimeMs === undefined && packetLossRatio === undefined) {
    return 'unknown';
  }
  if (
    (roundTripTimeMs !== undefined && roundTripTimeMs > FAIR_MAX_RTT_MS) ||
    (packetLossRatio !== undefined && packetLossRatio > FAIR_MAX_PACKET_LOSS_RATIO)
  ) {
    return 'poor';
  }
  if (
    (roundTripTimeMs !== undefined && roundTripTimeMs > GOOD_MAX_RTT_MS) ||
    (packetLossRatio !== undefined && packetLossRatio > GOOD_MAX_PACKET_LOSS_RATIO)
  ) {
    return 'fair';
  }
  return 'good';
}

function readNetworkMeasurement(statsReport: RTCStatsReport): {
  readonly roundTripTimeMs?: number;
  readonly packetCounters: NetworkPacketCounters;
  readonly trafficCounters: NetworkTrafficCounters;
} {
  const stats: QualityStats[] = [];
  statsReport.forEach((value) => stats.push(value as QualityStats));
  const selectedPairId = stats.find((entry) => entry.type === 'transport')
    ?.selectedCandidatePairId;
  const selectedPair =
    (selectedPairId === undefined
      ? undefined
      : stats.find((entry) => entry.id === selectedPairId)) ??
    stats.find(
      (entry) =>
        entry.type === 'candidate-pair' &&
        entry.state === 'succeeded' &&
        (entry.nominated === true || entry.selected === true),
    );
  const remoteInboundAudio = stats.find(
    (entry) =>
      entry.type === 'remote-inbound-rtp' &&
      (entry.kind === 'audio' || entry.mediaType === 'audio'),
  );
  const roundTripTimeSeconds =
    selectedPair?.currentRoundTripTime ?? remoteInboundAudio?.roundTripTime;
  const inboundAudio = stats.filter(
    (entry) =>
      entry.type === 'inbound-rtp' &&
      (entry.kind === 'audio' || entry.mediaType === 'audio'),
  );
  const outboundAudio = stats.filter(
    (entry) =>
      entry.type === 'outbound-rtp' &&
      (entry.kind === 'audio' || entry.mediaType === 'audio'),
  );
  const audioRtpStats = [...inboundAudio, ...outboundAudio];
  return {
    ...(roundTripTimeSeconds === undefined
      ? {}
      : { roundTripTimeMs: roundTripTimeSeconds * 1_000 }),
    packetCounters: {
      received: inboundAudio.reduce((total, entry) => total + (entry.packetsReceived ?? 0), 0),
      lost: inboundAudio.reduce((total, entry) => total + Math.max(0, entry.packetsLost ?? 0), 0),
    },
    trafficCounters: {
      timestampMs: audioRtpStats.reduce(
        (latest, entry) => Math.max(latest, entry.timestamp),
        0,
      ),
      bytesReceived: inboundAudio.reduce(
        (total, entry) => total + Math.max(0, entry.bytesReceived ?? 0),
        0,
      ),
      bytesSent: outboundAudio.reduce(
        (total, entry) => total + Math.max(0, entry.bytesSent ?? 0),
        0,
      ),
    },
  };
}

function calculatePacketLossRatio(
  current: NetworkPacketCounters,
  previous?: NetworkPacketCounters,
): number | undefined {
  const received = Math.max(0, current.received - (previous?.received ?? 0));
  const lost = Math.max(0, current.lost - (previous?.lost ?? 0));
  const total = received + lost;
  return total === 0 ? undefined : lost / total;
}

export function calculateNetworkKilobytesPerSecond(
  current: NetworkTrafficCounters,
  previous?: NetworkTrafficCounters,
): number | undefined {
  if (previous === undefined) {
    return undefined;
  }
  const elapsedSeconds = (current.timestampMs - previous.timestampMs) / 1_000;
  if (elapsedSeconds <= 0) {
    return undefined;
  }
  const receivedBytes = Math.max(0, current.bytesReceived - previous.bytesReceived);
  const sentBytes = Math.max(0, current.bytesSent - previous.bytesSent);
  const kilobytesPerSecond =
    (receivedBytes + sentBytes) / BYTES_PER_KILOBYTE / elapsedSeconds;
  return Math.round(kilobytesPerSecond * 10) / 10;
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function mapMediaAcquisitionError(error: unknown): MiCallError {
  const errorName = error instanceof Error ? error.name : undefined;
  const deviceMissing =
    errorName === 'NotFoundError' ||
    errorName === 'OverconstrainedError' ||
    errorName === 'NotReadableError' ||
    errorName === 'AbortError';
  return new MiCallError(
    deviceMissing ? 'MEDIA_DEVICE_NOT_FOUND' : 'MEDIA_PERMISSION_DENIED',
    deviceMissing ? 'Requested microphone is unavailable.' : 'Microphone permission was denied.',
    { recoverable: true, cause: error },
  );
}

function toMediaDeviceError(error: unknown, message: string): MiCallError {
  if (error instanceof MiCallError) {
    return error;
  }
  const errorName = error instanceof Error ? error.name : undefined;
  const permissionDenied = errorName === 'NotAllowedError' || errorName === 'SecurityError';
  return new MiCallError(
    permissionDenied ? 'MEDIA_PERMISSION_DENIED' : 'MEDIA_DEVICE_NOT_FOUND',
    message,
    { recoverable: true, cause: error },
  );
}
