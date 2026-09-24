import { describe, expect, it } from 'vitest';

describe('SSR import safety', () => {
  it('imports runtime packages without starting network, media or DOM work', async () => {
    const [core, sipAdapter, callScreen, sdkWeb] = await Promise.all([
      import('../../packages/core/src/index.js'),
      import('../../packages/sipjs-browser/src/index.js'),
      import('../../packages/call-screen/src/index.js'),
      import('../../packages/sdk-web/src/index.js'),
    ]);

    expect(core.MiCallClient).toBeTypeOf('function');
    expect(sipAdapter.SipJsSignaling).toBeTypeOf('function');
    expect(callScreen.defineCallScreen).toBeTypeOf('function');
    expect(sdkWeb.createMiCallSDK).toBeTypeOf('function');
  });
});
