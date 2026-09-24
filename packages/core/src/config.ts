import type { LogLevel } from './logging.js';
import type { LoggerPort } from './ports.js';

export interface IceServerConfig {
  readonly urls: string | readonly string[];
  readonly username?: string;
  readonly credential?: string;
}

export type IncomingHeaderMapper = (
  headers: Readonly<Record<string, string>>,
) => Readonly<Record<string, string>>;

export interface MiCallConfig {
  readonly sip: {
    readonly uri: string;
    readonly wssServer: string;
    readonly authorizationUsername: string;
    readonly authorizationPassword: string;
    readonly displayName?: string;
    readonly registerExpiresSeconds?: number;
  };
  readonly rtc?: {
    readonly iceServers?: readonly IceServerConfig[];
  };
  readonly registration?: {
    readonly autoRegister?: boolean;
  };
  readonly incomingHeaders?: {
    readonly allowlist?: readonly string[];
    readonly map?: IncomingHeaderMapper;
  };
  readonly outgoingCallTimeoutMs?: number;
  readonly logging?: {
    readonly level?: LogLevel | 'none';
    readonly customLogger?: LoggerPort;
    readonly enableDiagnosticsBuffer?: boolean;
    readonly maxBufferSize?: number;
  };
}
