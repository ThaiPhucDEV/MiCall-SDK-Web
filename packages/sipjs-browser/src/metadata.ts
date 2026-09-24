import { MiCallError } from '@micall/core';
import type { IncomingHeadersConfig } from './config.js';

export interface HeaderReader {
  getHeader(name: string): string | undefined;
}

function normalizeStringRecord(
  value: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const normalized: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      throw new MiCallError(
        'INVALID_CONFIG',
        'Incoming metadata mapper must return string values.',
      );
    }
    normalized[key.toLowerCase()] = item;
  }
  return Object.freeze(normalized);
}

export function extractIncomingMetadata(
  request: HeaderReader,
  config: IncomingHeadersConfig | undefined,
): Readonly<Record<string, string>> {
  const metadata: Record<string, string> = {};
  for (const configuredName of config?.allowlist ?? []) {
    const normalizedName = configuredName.trim().toLowerCase();
    if (normalizedName.length === 0) {
      continue;
    }
    const value = request.getHeader(configuredName);
    if (value !== undefined) {
      metadata[normalizedName] = value;
    }
  }

  const base = Object.freeze(metadata);
  return config?.map === undefined ? base : normalizeStringRecord(config.map(base));
}
