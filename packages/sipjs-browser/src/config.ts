import { MiCallError } from '@micall/core';

export type IncomingMetadataMapper = (
  metadata: Readonly<Record<string, string>>,
) => Readonly<Record<string, string>>;

export interface IncomingHeadersConfig {
  readonly allowlist?: readonly string[];
  readonly map?: IncomingMetadataMapper;
}

export interface SipJsBrowserConfig {
  readonly uri: string;
  readonly authorizationUsername: string;
  readonly authorizationPassword: string;
  readonly wssServer: string;
  readonly displayName?: string;
  readonly registerExpiresSeconds?: number;
  readonly outgoingCallTimeoutMs?: number;
  readonly incomingHeaders?: IncomingHeadersConfig;
  readonly iceServers?: readonly RTCIceServer[];
  readonly ringtoneUrl?: string;
}

export interface ResolvedSipJsBrowserConfig extends SipJsBrowserConfig {
  readonly registerExpiresSeconds: number;
  readonly outgoingCallTimeoutMs: number;
}

export function resolveConfig(config: SipJsBrowserConfig): ResolvedSipJsBrowserConfig {
  if (!config.uri.trim().startsWith('sip:') && !config.uri.trim().startsWith('sips:')) {
    throw new MiCallError('INVALID_CONFIG', 'sip.uri must be a valid sip: or sips: URI.');
  }
  if (!config.wssServer.trim().startsWith('wss://')) {
    throw new MiCallError('INVALID_CONFIG', 'sip.wssServer must use wss://.');
  }
  if (config.authorizationUsername.trim().length === 0) {
    throw new MiCallError('INVALID_CONFIG', 'sip.authorizationUsername must not be empty.');
  }
  if (config.authorizationPassword.length === 0) {
    throw new MiCallError('INVALID_CONFIG', 'sip.authorizationPassword must not be empty.');
  }

  const registerExpiresSeconds = config.registerExpiresSeconds ?? 600;
  const outgoingCallTimeoutMs = config.outgoingCallTimeoutMs ?? 120_000;
  if (!Number.isInteger(registerExpiresSeconds) || registerExpiresSeconds < 60) {
    throw new MiCallError('INVALID_CONFIG', 'registerExpiresSeconds must be at least 60.');
  }
  if (!Number.isFinite(outgoingCallTimeoutMs) || outgoingCallTimeoutMs < 1_000) {
    throw new MiCallError('INVALID_CONFIG', 'outgoingCallTimeoutMs must be at least 1000.');
  }

  return Object.freeze({ ...config, registerExpiresSeconds, outgoingCallTimeoutMs });
}
