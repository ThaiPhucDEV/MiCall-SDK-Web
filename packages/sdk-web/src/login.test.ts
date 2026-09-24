import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MiCallApiClient,
  MiCallApiError,
  createMiCallConfigFromSipAccount,
  decodeMiCallSipProfile,
} from './login.js';

const separator = 'b6aed9ab7cdf85432c321757b4d48153';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MiCall login profile', () => {
  it('decodes the Flutter-compatible six-field SIP profile', () => {
    const encoded = encodeProfile([
      'pbx.example.com',
      '7443',
      'proxy.example.com',
      '1001',
      'sip-secret',
      'turn:turn.example.com:3478',
    ]);

    expect(decodeMiCallSipProfile(encoded)).toEqual({
      domain: 'pbx.example.com',
      port: '7443',
      proxy: 'proxy.example.com',
      extension: '1001',
      password: 'sip-secret',
      transport: 'turn:turn.example.com:3478',
    });
  });

  it('maps a decoded account into the Web SDK SIP and TURN config', () => {
    const config = createMiCallConfigFromSipAccount({
      domain: 'pbx.example.com',
      port: '7443',
      proxy: 'proxy.example.com',
      extension: '1001',
      password: 'sip-secret',
      transport: 'turn:turn.example.com:3478',
    });

    expect(config).toEqual({
      sip: {
        wssServer: 'wss://proxy.example.com:7443/wss',
        uri: 'sip:1001@pbx.example.com',
        authorizationUsername: '1001',
        authorizationPassword: 'sip-secret',
        displayName: '1001',
        registerExpiresSeconds: 600,
      },
      rtc: {
        iceServers: [
          {
            urls: 'turn:turn.example.com:3478',
            username: '1001',
            credential: 'sip-secret',
          },
        ],
      },
    });
  });

  it('posts loginCti without exposing credentials in the returned public error', async () => {
    let requestBody = '';
    const fetchImplementation: typeof globalThis.fetch = async (_input, init) => {
      requestBody = String(init?.body ?? '');
      return new Response(
        JSON.stringify({
          success: {
            data: encodeProfile([
              'pbx.example.com',
              '7443',
              'proxy.example.com',
              '1001',
              'sip-secret',
              'turn:turn.example.com:3478',
            ]),
            token: 'access-token',
            user: { secret: 'device-secret' },
            user_log: { id: 12345 },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const client = new MiCallApiClient({ fetchImplementation });

    const session = await client.login({ email: 'agent@example.com', password: 'login-secret' });

    expect(JSON.parse(requestBody)).toEqual({
      email: 'agent@example.com',
      password: 'login-secret',
      type: 'rtc',
      type_app: 'micall',
      public: false,
    });
    expect(session.sipAccount.extension).toBe('1001');
    expect(session.accessToken).toBe('access-token');
    expect(session.deviceRegistrationSecret).toBe('device-secret');
    expect(session.userLogId).toBe(12345);
  });

  it('binds browser-native fetch to globalThis', async () => {
    let actualReceiver: unknown;
    const browserFetch = function (this: unknown): Promise<Response> {
      actualReceiver = this;
      if (this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      return Promise.resolve(createSuccessfulLoginResponse());
    } as typeof globalThis.fetch;
    vi.stubGlobal('fetch', browserFetch);
    const client = new MiCallApiClient();

    const session = await client.login({
      email: 'agent@example.com',
      password: 'login-secret',
    });

    expect(actualReceiver).toBe(globalThis);
    expect(session.sipAccount.extension).toBe('1001');
  });

  it('rejects malformed profiles with a safe error', () => {
    expect(() => decodeMiCallSipProfile('not-a-profile')).toThrowError(
      expect.objectContaining<Partial<MiCallApiError>>({
        code: 'INVALID_RESPONSE',
        message: 'SIP profile không đúng định dạng.',
      }),
    );
  });

  it('extracts backend error message on 406 response', async () => {
    const fetchImplementation: typeof globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: { errors: { info: 'Email hoặc mật khẩu không chính xác.' } },
          code: 406,
          message: 'Invalid parameters',
        }),
        { status: 406, headers: { 'Content-Type': 'application/json' } },
      );
    const client = new MiCallApiClient({ fetchImplementation });

    await expect(
      client.login({ email: 'wrong@example.com', password: 'wrong' }),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<MiCallApiError>>({
        code: 'UNAUTHORIZED',
        message: 'Email hoặc mật khẩu không chính xác.',
        statusCode: 406,
      }),
    );
  });
});

function encodeProfile(values: readonly string[]): string {
  let encoded = values.map(encodeBase64Utf8).join(separator);
  for (let round = 0; round < 3; round += 1) encoded = encodeBase64Utf8(encoded);
  return encoded;
}

function createSuccessfulLoginResponse(): Response {
  return new Response(
    JSON.stringify({
      success: {
        data: encodeProfile([
          'pbx.example.com',
          '7443',
          'proxy.example.com',
          '1001',
          'sip-secret',
          'turn:turn.example.com:3478',
        ]),
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}
