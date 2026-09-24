import type { MiCallConfig } from '@micall/core';

const SIP_PROFILE_SEPARATOR = 'b6aed9ab7cdf85432c321757b4d48153';
const SIP_PROFILE_DECODE_ROUNDS = 3;
const SIP_PROFILE_FIELD_COUNT = 6;
const MAX_PROFILE_SEGMENTS = 16;
const MAX_ENCODED_PROFILE_LENGTH = 262_144;

export const DEFAULT_MICALL_API_BASE_URL: string = 'https://api-portal-02.mipbx.vn/api/v1/';
export const MICALL_LOGIN_PATH: string = 'loginCti';

export type MiCallApiErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_INPUT'
  | 'UNAUTHORIZED'
  | 'REJECTED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'SERVER'
  | 'INVALID_RESPONSE'
  | 'CANCELLED'
  | 'UNKNOWN';

export class MiCallApiError extends Error {
  public readonly code: MiCallApiErrorCode;
  public readonly retryable: boolean;
  public readonly statusCode?: number;

  public constructor(
    code: MiCallApiErrorCode,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly statusCode?: number;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'MiCallApiError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.statusCode !== undefined) this.statusCode = options.statusCode;
  }
}

export interface MiCallSipAccount {
  readonly domain: string;
  readonly port: string;
  readonly proxy: string;
  readonly extension: string;
  readonly password: string;
  readonly transport: string;
}

export interface MiCallLoginSession {
  readonly sipAccount: MiCallSipAccount;
  readonly accessToken?: string;
  readonly deviceRegistrationSecret?: string;
  readonly userLogId?: number;
}

export interface MiCallLoginRequest {
  readonly email: string;
  readonly password: string;
  readonly signal?: AbortSignal;
}

export interface MiCallApiClientOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchImplementation?: typeof globalThis.fetch;
}

export interface SipAccountConfigOptions {
  readonly registerExpiresSeconds?: number;
  readonly useTurnServer?: boolean;
}

export class MiCallApiClient {
  readonly #loginUrl: URL;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  public constructor(options: MiCallApiClientOptions = {}) {
    this.#loginUrl = resolveLoginUrl(options.baseUrl ?? DEFAULT_MICALL_API_BASE_URL);
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs < 1_000) {
      throw new MiCallApiError(
        'INVALID_CONFIGURATION',
        'MiCall API timeout must be at least 1000 milliseconds.',
      );
    }
    this.#fetch = resolveFetchImplementation(options.fetchImplementation);
  }

  public async login(request: MiCallLoginRequest): Promise<MiCallLoginSession> {
    const email = request.email.trim();
    if (email.length === 0 || request.password.length === 0) {
      throw new MiCallApiError('INVALID_INPUT', 'Email và password không được để trống.');
    }

    const abort = createRequestAbort(this.#timeoutMs, request.signal);
    try {
      const response = await this.#fetch(this.#loginUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          password: request.password,
          type: 'rtc',
          type_app: 'micall',
          public: false,
        }),
        credentials: 'omit',
        signal: abort.signal,
      });
      if (!response.ok) {
        const errorBody = await parseResponseBody(response).catch(() => undefined);
        throw mapHttpError(response.status, errorBody);
      }
      const body = await parseResponseBody(response);
      return parseLoginResponse(body);
    } catch (error) {
      if (error instanceof MiCallApiError) throw error;
      if (abort.signal.aborted) {
        if (request.signal?.aborted === true) {
          throw new MiCallApiError('CANCELLED', 'Yêu cầu đăng nhập đã bị hủy.', {
            cause: error,
          });
        }
        throw new MiCallApiError('TIMEOUT', 'Kết nối MiCall API quá thời gian chờ.', {
          retryable: true,
          cause: error,
        });
      }
      throw new MiCallApiError('NETWORK', 'Không thể kết nối MiCall API.', {
        retryable: true,
        cause: error,
      });
    } finally {
      abort.dispose();
    }
  }
}

function resolveFetchImplementation(
  customFetch: typeof globalThis.fetch | undefined,
): typeof globalThis.fetch {
  if (customFetch !== undefined) return customFetch;

  const nativeFetch = globalThis.fetch;
  if (typeof nativeFetch !== 'function') {
    throw new MiCallApiError(
      'INVALID_CONFIGURATION',
      'The current runtime does not provide fetch().',
    );
  }

  // Browser-native fetch may reject when detached from Window/globalThis.
  return nativeFetch.bind(globalThis);
}

export function decodeMiCallSipProfile(encodedProfile: string): MiCallSipAccount {
  if (encodedProfile.length === 0 || encodedProfile.length > MAX_ENCODED_PROFILE_LENGTH) {
    throw invalidProfileError();
  }

  try {
    let decoded = encodedProfile;
    for (let round = 0; round < SIP_PROFILE_DECODE_ROUNDS; round += 1) {
      decoded = decodeBase64Utf8(decoded);
    }
    const parts = decoded.split(SIP_PROFILE_SEPARATOR);
    if (parts.length < SIP_PROFILE_FIELD_COUNT || parts.length > MAX_PROFILE_SEGMENTS) {
      throw new Error('Unexpected SIP profile segment count.');
    }
    const values = parts.slice(0, SIP_PROFILE_FIELD_COUNT).map((field) => decodeBase64Utf8(field));
    if (values.some((value) => value.trim().length === 0)) {
      throw new Error('SIP profile contains an empty field.');
    }

    const [domain, port, proxy, extension, password, transport] = values;
    if (
      domain === undefined ||
      port === undefined ||
      proxy === undefined ||
      extension === undefined ||
      password === undefined ||
      transport === undefined
    ) {
      throw new Error('SIP profile is incomplete.');
    }
    return Object.freeze({
      domain: domain.trim(),
      port: port.trim(),
      proxy: proxy.trim(),
      extension: extension.trim(),
      password,
      transport: transport.trim(),
    });
  } catch (error) {
    if (error instanceof MiCallApiError) throw error;
    throw invalidProfileError(error);
  }
}

export function createMiCallConfigFromSipAccount(
  account: MiCallSipAccount,
  options: SipAccountConfigOptions = {},
): MiCallConfig {
  validateSipAccount(account);
  const registerExpiresSeconds = options.registerExpiresSeconds ?? 600;
  const useTurnServer = options.useTurnServer ?? true;
  const wssServer = createWebSocketUrl(account);
  return Object.freeze({
    sip: Object.freeze({
      wssServer,
      uri: `sip:${account.extension}@${account.domain}`,
      authorizationUsername: account.extension,
      authorizationPassword: account.password,
      displayName: account.extension,
      registerExpiresSeconds,
    }),
    ...(useTurnServer && account.transport.length > 0
      ? {
          rtc: Object.freeze({
            iceServers: Object.freeze([
              Object.freeze({
                urls: account.transport,
                username: account.extension,
                credential: account.password,
              }),
            ]),
          }),
        }
      : {}),
  });
}

function parseLoginResponse(body: unknown): MiCallLoginSession {
  if (!isRecord(body) || !isRecord(body.success)) {
    throw new MiCallApiError('REJECTED', 'Tài khoản hoặc mật khẩu không hợp lệ.');
  }
  const success = body.success;
  if (typeof success.data !== 'string' || success.data.length === 0) {
    throw new MiCallApiError('INVALID_RESPONSE', 'Backend không trả về SIP profile hợp lệ.');
  }

  const user = isRecord(success.user) ? success.user : undefined;
  const userLog = isRecord(success.user_log) ? success.user_log : undefined;
  const userLogId = parsePositiveInteger(userLog?.id);
  const accessToken = nonEmptyString(success.token);
  const deviceRegistrationSecret = nonEmptyString(user?.secret);

  return Object.freeze({
    sipAccount: decodeMiCallSipProfile(success.data),
    ...(accessToken === undefined ? {} : { accessToken }),
    ...(deviceRegistrationSecret === undefined ? {} : { deviceRegistrationSecret }),
    ...(userLogId === undefined ? {} : { userLogId }),
  });
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new MiCallApiError('INVALID_RESPONSE', 'Response đăng nhập không phải JSON hợp lệ.', {
      cause: error,
    });
  }
}

function extractErrorMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  if (
    isRecord(body.error) &&
    isRecord(body.error.errors) &&
    typeof body.error.errors.info === 'string' &&
    body.error.errors.info.trim().length > 0
  ) {
    return body.error.errors.info.trim();
  }
  if (typeof body.message === 'string' && body.message.trim().length > 0) {
    return body.message.trim();
  }
  return undefined;
}

function mapHttpError(statusCode: number, body?: unknown): MiCallApiError {
  const backendMessage = extractErrorMessage(body);
  if (statusCode === 401 || statusCode === 403 || statusCode === 406) {
    return new MiCallApiError(
      'UNAUTHORIZED',
      backendMessage ?? 'Tài khoản hoặc mật khẩu không hợp lệ.',
      { statusCode },
    );
  }
  if (statusCode >= 500) {
    return new MiCallApiError(
      'SERVER',
      backendMessage ?? 'MiCall API đang tạm thời không khả dụng.',
      { retryable: true, statusCode },
    );
  }
  return new MiCallApiError(
    'REJECTED',
    backendMessage ?? 'MiCall API từ chối yêu cầu đăng nhập.',
    { statusCode },
  );
}

function resolveLoginUrl(baseUrl: string): URL {
  try {
    const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const baseOrigin =
      typeof window !== 'undefined' && window.location?.origin
        ? window.location.origin
        : undefined;
    const url = new URL(MICALL_LOGIN_PATH, new URL(normalizedBaseUrl, baseOrigin));
    const isLocalhost =
      url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.protocol !== 'https:' && !isLocalhost) {
      throw new Error('Insecure API URL.');
    }
    return url;
  } catch (error) {
    throw new MiCallApiError(
      'INVALID_CONFIGURATION',
      'MiCall API base URL must be a valid HTTPS URL.',
      { cause: error },
    );
  }
}

function createWebSocketUrl(account: MiCallSipAccount): string {
  const candidate = `wss://${account.proxy}:${account.port}/wss`;
  try {
    if (/[\s/@?#]/.test(account.proxy)) throw new Error('Invalid SIP proxy host.');
    const url = new URL(candidate);
    if (url.protocol !== 'wss:' || url.hostname.length === 0) {
      throw new Error('Invalid SIP WebSocket URL.');
    }
    return candidate;
  } catch (error) {
    throw new MiCallApiError('INVALID_RESPONSE', 'SIP proxy hoặc WSS port không hợp lệ.', {
      cause: error,
    });
  }
}

function validateSipAccount(account: MiCallSipAccount): void {
  const requiredValues = [
    account.domain,
    account.port,
    account.proxy,
    account.extension,
    account.password,
  ];
  if (requiredValues.some((value) => value.trim().length === 0)) {
    throw invalidProfileError();
  }
  const port = Number(account.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new MiCallApiError('INVALID_RESPONSE', 'SIP WSS port không hợp lệ.');
  }
  if (!/^[A-Za-z0-9_.!~*'()%+-]+$/.test(account.extension)) {
    throw new MiCallApiError('INVALID_RESPONSE', 'SIP extension không hợp lệ.');
  }
  if (/[\s/@?#]/.test(account.domain)) {
    throw new MiCallApiError('INVALID_RESPONSE', 'SIP domain không hợp lệ.');
  }
}

function decodeBase64Utf8(encoded: string): string {
  const binary = globalThis.atob(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function createRequestAbort(
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted === true) forwardAbort();
  else externalSignal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    dispose(): void {
      globalThis.clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', forwardAbort);
    },
  };
}

function invalidProfileError(cause?: unknown): MiCallApiError {
  return new MiCallApiError('INVALID_RESPONSE', 'SIP profile không đúng định dạng.', {
    ...(cause === undefined ? {} : { cause }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function parsePositiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
