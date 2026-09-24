export type MiCallErrorCode =
  | 'INVALID_CONFIG'
  | 'INVALID_DESTINATION'
  | 'INVALID_CALL_STATE'
  | 'CALL_NOT_FOUND'
  | 'CALL_ALREADY_EXISTS'
  | 'CLIENT_DESTROYED'
  | 'MEDIA_PERMISSION_DENIED'
  | 'MEDIA_DEVICE_NOT_FOUND'
  | 'AUDIO_OUTPUT_UNSUPPORTED'
  | 'TRANSPORT_FAILED'
  | 'REGISTRATION_FAILED'
  | 'AUTHENTICATION_FAILED'
  | 'CALL_FAILED'
  | 'HOLD_REJECTED'
  | 'TRANSFER_REJECTED'
  | 'DTMF_UNSUPPORTED'
  | 'UI_TAG_CONFLICT'
  | 'UI_UNAVAILABLE'
  | 'OPERATION_TIMEOUT'
  | 'INTERNAL_ERROR';

export type ErrorContextValue = string | number | boolean | null;
export type ErrorContext = Readonly<Record<string, ErrorContextValue>>;

const sensitiveContextKey =
  /authorization|password|passwd|secret|token|credential|icepwd|email|phone|customer|raw|sdp/i;

function redactErrorContext(context: ErrorContext): ErrorContext {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(context).map(([key, value]) => [
        key,
        sensitiveContextKey.test(key) ? '[REDACTED]' : value,
      ]),
    ),
  );
}

export class MiCallError extends Error {
  public readonly code: MiCallErrorCode;
  public readonly recoverable: boolean;
  public readonly callId?: string;
  public readonly context: ErrorContext;

  public constructor(
    code: MiCallErrorCode,
    message: string,
    options: {
      readonly recoverable?: boolean;
      readonly callId?: string;
      readonly context?: ErrorContext;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'MiCallError';
    this.code = code;
    this.recoverable = options.recoverable ?? false;
    this.context = redactErrorContext(options.context ?? {});
    if (options.callId !== undefined) {
      this.callId = options.callId;
    }
  }
}

export function toMiCallError(
  error: unknown,
  fallbackCode: MiCallErrorCode,
  fallbackMessage: string,
  callId?: string,
): MiCallError {
  if (error instanceof MiCallError) {
    return error;
  }

  return new MiCallError(fallbackCode, fallbackMessage, {
    ...(callId === undefined ? {} : { callId }),
    cause: error,
  });
}
