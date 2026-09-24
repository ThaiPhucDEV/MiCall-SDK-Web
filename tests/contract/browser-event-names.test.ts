import { describe, expect, it } from 'vitest';
import { MICALL_DOM_EVENT_NAMES } from '../../packages/sdk-web/src/index.js';

describe('browser DOM event contract', () => {
  it('keeps stable host-language agnostic event names', () => {
    expect(MICALL_DOM_EVENT_NAMES).toEqual({
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
    });
  });
});
