import { describe, expect, it } from 'vitest';
import { HtmlAudioRingtone } from './browser-media.js';

class FakeAudio {
  public currentTime = 0;
  public loop = false;
  public muted = false;
  public paused = true;
  public preload = '';
  public src = '';
  public srcObject: MediaProvider | null = null;
  public playCount = 0;

  public async play(): Promise<void> {
    this.playCount += 1;
    this.paused = false;
  }

  public pause(): void {
    this.paused = true;
  }

  public load(): void {
    return;
  }

  public removeAttribute(): void {
    return;
  }
}

describe('HtmlAudioRingtone', () => {
  it('uses a muted probe and pauses when no ringtone is active', async () => {
    const audio = new FakeAudio();
    const ringtone = new HtmlAudioRingtone(
      '/ringtone.mp3',
      () => audio as unknown as HTMLAudioElement,
    );

    await expect(ringtone.unlock()).resolves.toBe(true);

    expect(audio.muted).toBe(false);
    expect(audio.paused).toBe(true);
  });

  it('keeps an active ringtone playing after audio is unlocked', async () => {
    const audio = new FakeAudio();
    const ringtone = new HtmlAudioRingtone(
      '/ringtone.mp3',
      () => audio as unknown as HTMLAudioElement,
    );
    await ringtone.play('call-1');

    await expect(ringtone.unlock()).resolves.toBe(true);

    expect(audio.muted).toBe(false);
    expect(audio.paused).toBe(false);
    expect(audio.playCount).toBe(3);
  });

  it('reuses the ringtone output element and plays the hangup tone once', async () => {
    const audio = new FakeAudio();
    const ringtone = new HtmlAudioRingtone(
      '/incoming.mp3',
      () => audio as unknown as HTMLAudioElement,
      '/hangup.mp3',
    );

    await ringtone.play('call-1');
    await ringtone.playHangup();

    expect(audio.src).toBe('/hangup.mp3');
    expect(audio.loop).toBe(false);
    expect(audio.currentTime).toBe(0);
    expect(audio.playCount).toBe(2);
  });
});
