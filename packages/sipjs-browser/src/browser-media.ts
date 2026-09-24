import { MiCallError } from '@micall/core';

export const DEFAULT_RINGTONE_URL = new URL(
  '../assets/ringtones/incoming-sound.mp3',
  import.meta.url,
).href;
export const DEFAULT_HANGUP_TONE_URL = new URL(
  '../assets/ringtones/hangup.mp3',
  import.meta.url,
).href;

export interface MicrophonePermissionGate {
  ensureAccess(): Promise<void>;
}

export interface MediaDevicesLike {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

export class BrowserMicrophonePermissionGate implements MicrophonePermissionGate {
  readonly #mediaDevices: MediaDevicesLike | undefined;

  public constructor(
    mediaDevices: MediaDevicesLike | undefined = globalThis.navigator?.mediaDevices,
  ) {
    this.#mediaDevices = mediaDevices;
  }

  public async ensureAccess(): Promise<void> {
    if (this.#mediaDevices === undefined) {
      throw new MiCallError('MEDIA_PERMISSION_DENIED', 'Microphone access is unavailable.');
    }

    let stream: MediaStream;
    try {
      stream = await this.#mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (error) {
      throw new MiCallError('MEDIA_PERMISSION_DENIED', 'Microphone permission was denied.', {
        recoverable: true,
        cause: error,
      });
    }

    for (const track of stream.getTracks()) {
      track.stop();
    }
  }
}

export interface RingtonePort {
  play(callId: string): Promise<void>;
  playHangup?(): Promise<void>;
  stop(callId: string): void;
  unlock(): Promise<boolean>;
  setOutputDevice(deviceId: string): Promise<void>;
  supportsOutputSelection(): boolean;
  destroy(): void;
}

export class HtmlAudioRingtone implements RingtonePort {
  readonly #incomingSourceUrl: string;
  readonly #hangupSourceUrl: string;
  readonly #audioFactory: () => HTMLAudioElement;
  #audio: HTMLAudioElement | undefined;
  #activeSourceUrl: string | undefined;
  #callId: string | undefined;

  public constructor(
    incomingSourceUrl: string,
    audioFactory: () => HTMLAudioElement = () => new Audio(),
    hangupSourceUrl: string = DEFAULT_HANGUP_TONE_URL,
  ) {
    this.#incomingSourceUrl = incomingSourceUrl;
    this.#hangupSourceUrl = hangupSourceUrl;
    this.#audioFactory = audioFactory;
  }

  public async play(callId: string): Promise<void> {
    const audio = this.#getAudio();
    this.#selectSource(audio, this.#incomingSourceUrl, true);
    this.#callId = callId;
    audio.currentTime = 0;
    await audio.play();
  }

  public async playHangup(): Promise<void> {
    const audio = this.#getAudio();
    this.#callId = undefined;
    audio.pause();
    this.#selectSource(audio, this.#hangupSourceUrl, false);
    audio.currentTime = 0;
    await audio.play();
  }

  public stop(callId: string): void {
    if (this.#callId !== callId) {
      return;
    }
    this.#audio?.pause();
    if (this.#audio !== undefined) {
      this.#audio.currentTime = 0;
    }
    this.#callId = undefined;
  }

  public async unlock(): Promise<boolean> {
    const audio = this.#getAudio();
    const previousMuted = audio.muted;
    audio.muted = true;
    try {
      await audio.play();
      audio.muted = previousMuted;
      if (this.#callId === undefined) {
        audio.pause();
      } else {
        await audio.play();
      }
      return true;
    } catch {
      return false;
    } finally {
      audio.muted = previousMuted;
    }
  }

  public async setOutputDevice(deviceId: string): Promise<void> {
    const audio = this.#getAudio();
    if (typeof audio.setSinkId !== 'function') {
      throw new MiCallError(
        'AUDIO_OUTPUT_UNSUPPORTED',
        'This browser does not support ringtone output selection.',
        { recoverable: true },
      );
    }
    try {
      await audio.setSinkId(deviceId);
    } catch (error) {
      throw new MiCallError('MEDIA_DEVICE_NOT_FOUND', 'Unable to select ringtone output.', {
        recoverable: true,
        cause: error,
      });
    }
  }

  public supportsOutputSelection(): boolean {
    return typeof this.#getAudio().setSinkId === 'function';
  }

  public destroy(): void {
    this.#audio?.pause();
    if (this.#audio !== undefined) {
      this.#audio.srcObject = null;
      this.#audio.removeAttribute('src');
      this.#audio.load();
    }
    this.#audio = undefined;
    this.#activeSourceUrl = undefined;
    this.#callId = undefined;
  }

  #getAudio(): HTMLAudioElement {
    if (this.#audio === undefined) {
      this.#audio = this.#audioFactory();
      this.#audio.preload = 'auto';
      this.#selectSource(this.#audio, this.#incomingSourceUrl, true);
    }
    return this.#audio;
  }

  #selectSource(audio: HTMLAudioElement, sourceUrl: string, loop: boolean): void {
    audio.loop = loop;
    if (this.#activeSourceUrl === sourceUrl) {
      return;
    }
    audio.src = sourceUrl;
    audio.load();
    this.#activeSourceUrl = sourceUrl;
  }
}
