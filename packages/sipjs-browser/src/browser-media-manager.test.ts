import { describe, expect, it } from 'vitest';
import type { Web } from 'sip.js';
import {
  BrowserMediaManager,
  calculateNetworkKilobytesPerSecond,
  classifyNetworkQuality,
  type BrowserMediaDevices,
  type IntervalScheduler,
} from './browser-media-manager.js';

class FakeTrack {
  public readonly kind = 'audio';
  public enabled = true;
  public stopped = false;

  public stop(): void {
    this.stopped = true;
  }
}

class FakeStream {
  readonly #tracks: FakeTrack[];
  readonly #listeners = new Map<string, Set<EventListener>>();

  public constructor(tracks: FakeTrack[]) {
    this.#tracks = tracks;
  }

  public getTracks(): MediaStreamTrack[] {
    return [...this.#tracks] as unknown as MediaStreamTrack[];
  }

  public getAudioTracks(): MediaStreamTrack[] {
    return this.getTracks();
  }

  public addTrack(track: MediaStreamTrack): void {
    this.#tracks.push(track as unknown as FakeTrack);
  }

  public removeTrack(track: MediaStreamTrack): void {
    const index = this.#tracks.indexOf(track as unknown as FakeTrack);
    if (index >= 0) {
      this.#tracks.splice(index, 1);
    }
  }

  public addEventListener(type: string, listener: EventListener): void {
    const listeners = this.#listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: EventListener): void {
    this.#listeners.get(type)?.delete(listener);
  }
}

class FakeAudio {
  public autoplay = false;
  public srcObject: MediaProvider | null = null;
  public paused = false;

  public async play(): Promise<void> {
    return;
  }

  public pause(): void {
    this.paused = true;
  }
}

class FakeMediaDevices implements BrowserMediaDevices {
  public devices: MediaDeviceInfo[] = [];
  public nextStream: MediaStream | undefined;
  readonly #listeners = new Set<EventListener>();

  public async getUserMedia(): Promise<MediaStream> {
    if (this.nextStream === undefined) {
      throw new DOMException('No stream', 'NotFoundError');
    }
    return this.nextStream;
  }

  public async enumerateDevices(): Promise<MediaDeviceInfo[]> {
    return this.devices;
  }

  public addEventListener(_type: 'devicechange', listener: EventListener): void {
    this.#listeners.add(listener);
  }

  public removeEventListener(_type: 'devicechange', listener: EventListener): void {
    this.#listeners.delete(listener);
  }
}

class FakeIntervalScheduler implements IntervalScheduler {
  public readonly callbacks: Array<() => void> = [];
  public readonly clearedHandles: unknown[] = [];

  public set(callback: () => void): unknown {
    this.callbacks.push(callback);
    return callback;
  }

  public clear(handle: unknown): void {
    this.clearedHandles.push(handle);
  }
}

function createHandler(
  localStream: FakeStream,
  remoteStream: FakeStream,
  sender: {
    readonly track: MediaStreamTrack;
    replaceTrack(track: MediaStreamTrack): Promise<void>;
  },
  getStats?: () => Promise<RTCStatsReport>,
): Web.SessionDescriptionHandler {
  return {
    localMediaStream: localStream as unknown as MediaStream,
    remoteMediaStream: remoteStream as unknown as MediaStream,
    peerConnection: {
      getSenders: () => [sender],
      ...(getStats === undefined ? {} : { getStats }),
    },
  } as unknown as Web.SessionDescriptionHandler;
}

function mediaDevice(deviceId: string, kind: MediaDeviceKind): MediaDeviceInfo {
  return {
    deviceId,
    groupId: 'group-1',
    kind,
    label: deviceId,
    toJSON: () => ({}),
  };
}

describe('BrowserMediaManager', () => {
  it('classifies WebRTC latency and packet loss using call quality thresholds', () => {
    expect(classifyNetworkQuality({ roundTripTimeMs: 80, packetLossRatio: 0.01 })).toBe('good');
    expect(classifyNetworkQuality({ roundTripTimeMs: 220, packetLossRatio: 0.03 })).toBe('fair');
    expect(classifyNetworkQuality({ roundTripTimeMs: 420, packetLossRatio: 0.08 })).toBe('poor');
    expect(classifyNetworkQuality({})).toBe('unknown');
  });

  it('calculates total inbound and outbound audio traffic in KB/s', () => {
    expect(
      calculateNetworkKilobytesPerSecond(
        { timestampMs: 4_000, bytesReceived: 40_000, bytesSent: 20_000 },
        { timestampMs: 1_000, bytesReceived: 10_000, bytesSent: 5_000 },
      ),
    ).toBe(15);
    expect(
      calculateNetworkKilobytesPerSecond({
        timestampMs: 1_000,
        bytesReceived: 10_000,
        bytesSent: 5_000,
      }),
    ).toBeUndefined();
  });

  it('publishes WebRTC quality and stops polling when media is released', async () => {
    const scheduler = new FakeIntervalScheduler();
    const qualities: string[] = [];
    const throughputs: number[] = [];
    const localTrack = new FakeTrack();
    const localStream = new FakeStream([localTrack]);
    const remoteStream = new FakeStream([]);
    const sender = {
      track: localTrack as unknown as MediaStreamTrack,
      replaceTrack: async (): Promise<void> => undefined,
    };
    let stats = new Map<string, RTCStats>([
      [
        'pair-1',
        {
          id: 'pair-1',
          type: 'candidate-pair',
          timestamp: 1_000,
          state: 'succeeded',
          nominated: true,
          currentRoundTripTime: 0.08,
        } as RTCStats,
      ],
      [
        'inbound-1',
        {
          id: 'inbound-1',
          type: 'inbound-rtp',
          timestamp: 1_000,
          kind: 'audio',
          packetsReceived: 99,
          packetsLost: 1,
          bytesReceived: 10_000,
        } as RTCStats,
      ],
      [
        'outbound-1',
        {
          id: 'outbound-1',
          type: 'outbound-rtp',
          timestamp: 1_000,
          kind: 'audio',
          bytesSent: 5_000,
        } as RTCStats,
      ],
    ]) as unknown as RTCStatsReport;
    const manager = new BrowserMediaManager({
      audioFactory: () => new FakeAudio() as unknown as HTMLAudioElement,
      intervalScheduler: scheduler,
      onNetworkQualityChanged: (_callId, quality) => qualities.push(quality),
      onNetworkThroughputChanged: (_callId, throughput) => throughputs.push(throughput),
    });

    manager.attach(
      'call-1',
      createHandler(localStream, remoteStream, sender, async () => stats),
    );
    await Promise.resolve();
    await Promise.resolve();
    stats = new Map<string, RTCStats>([
      [
        'pair-1',
        {
          id: 'pair-1',
          type: 'candidate-pair',
          timestamp: 4_000,
          state: 'succeeded',
          nominated: true,
          currentRoundTripTime: 0.08,
        } as RTCStats,
      ],
      [
        'inbound-1',
        {
          id: 'inbound-1',
          type: 'inbound-rtp',
          timestamp: 4_000,
          kind: 'audio',
          packetsReceived: 198,
          packetsLost: 2,
          bytesReceived: 40_000,
        } as RTCStats,
      ],
      [
        'outbound-1',
        {
          id: 'outbound-1',
          type: 'outbound-rtp',
          timestamp: 4_000,
          kind: 'audio',
          bytesSent: 20_000,
        } as RTCStats,
      ],
    ]) as unknown as RTCStatsReport;
    scheduler.callbacks[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    manager.release('call-1');

    expect(qualities).toEqual(['good']);
    expect(throughputs).toEqual([15]);
    expect(scheduler.callbacks).toHaveLength(1);
    expect(scheduler.clearedHandles).toEqual([scheduler.callbacks[0]]);
  });

  it('mutes the outbound track and releases only SDK-owned media on call end', async () => {
    const localTrack = new FakeTrack();
    const localStream = new FakeStream([localTrack]);
    const remoteStream = new FakeStream([]);
    const audio = new FakeAudio();
    const sender = {
      track: localTrack as unknown as MediaStreamTrack,
      replaceTrack: async (): Promise<void> => undefined,
    };
    const manager = new BrowserMediaManager({
      audioFactory: () => audio as unknown as HTMLAudioElement,
    });
    manager.attach('call-1', createHandler(localStream, remoteStream, sender));

    await manager.setMuted('call-1', true);
    manager.release('call-1');

    expect(localTrack.enabled).toBe(false);
    expect(localTrack.stopped).toBe(true);
    expect(audio.paused).toBe(true);
    expect(audio.srcObject).toBeNull();
  });

  it('keeps the current microphone when outbound track replacement fails', async () => {
    const currentTrack = new FakeTrack();
    const replacementTrack = new FakeTrack();
    const localStream = new FakeStream([currentTrack]);
    const mediaDevices = new FakeMediaDevices();
    mediaDevices.devices = [mediaDevice('mic-2', 'audioinput')];
    mediaDevices.nextStream = new FakeStream([replacementTrack]) as unknown as MediaStream;
    const sender = {
      track: currentTrack as unknown as MediaStreamTrack,
      replaceTrack: async (): Promise<void> => {
        throw new Error('replace failed');
      },
    };
    const manager = new BrowserMediaManager({
      mediaDevices,
      audioFactory: () => new FakeAudio() as unknown as HTMLAudioElement,
    });
    manager.attach('call-1', createHandler(localStream, new FakeStream([]), sender));

    await expect(manager.selectAudioInput('mic-2')).rejects.toMatchObject({
      code: 'CALL_FAILED',
    });

    expect(localStream.getAudioTracks()).toEqual([currentTrack]);
    expect(currentTrack.stopped).toBe(false);
    expect(replacementTrack.stopped).toBe(true);
  });

  it('returns a typed error when output selection is unsupported', async () => {
    const mediaDevices = new FakeMediaDevices();
    mediaDevices.devices = [mediaDevice('speaker-1', 'audiooutput')];
    const manager = new BrowserMediaManager({
      mediaDevices,
      audioFactory: () => new FakeAudio() as unknown as HTMLAudioElement,
    });

    await expect(manager.selectCallAudioOutput('speaker-1')).rejects.toMatchObject({
      code: 'AUDIO_OUTPUT_UNSUPPORTED',
    });
  });
});
