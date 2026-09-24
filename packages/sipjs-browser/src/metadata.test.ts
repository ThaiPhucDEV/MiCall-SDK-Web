import { describe, expect, it } from 'vitest';
import { extractIncomingMetadata, type HeaderReader } from './metadata.js';

class CaseInsensitiveHeaders implements HeaderReader {
  readonly #headers: Readonly<Record<string, string>>;

  public constructor(headers: Readonly<Record<string, string>>) {
    this.#headers = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
    );
  }

  public getHeader(name: string): string | undefined {
    return this.#headers[name.toLowerCase()];
  }
}

describe('extractIncomingMetadata', () => {
  it('returns an empty record when no allowlist is configured', () => {
    const request = new CaseInsensitiveHeaders({ 'X-Secret': 'must-not-leak' });
    expect(extractIncomingMetadata(request, undefined)).toEqual({});
  });

  it('matches case-insensitively and exposes lowercase string keys only', () => {
    const request = new CaseInsensitiveHeaders({
      'x-my-extra-id': 'customer-1',
      'X-Ticket-Number': 'T-100',
      'X-Secret': 'must-not-leak',
    });
    const metadata = extractIncomingMetadata(request, {
      allowlist: ['X-My-Extra-Id', 'x-ticket-number'],
    });

    expect(metadata).toEqual({
      'x-my-extra-id': 'customer-1',
      'x-ticket-number': 'T-100',
    });
    expect(Object.isFrozen(metadata)).toBe(true);
  });

  it('normalizes mapper output keys without decoding business values', () => {
    const request = new CaseInsensitiveHeaders({ 'X-Customer': '%2B8499' });
    const metadata = extractIncomingMetadata(request, {
      allowlist: ['X-Customer'],
      map: (headers) => ({ Customer: headers['x-customer'] ?? '' }),
    });

    expect(metadata).toEqual({ customer: '%2B8499' });
  });
});
