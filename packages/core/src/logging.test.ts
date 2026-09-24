import { describe, expect, it } from 'vitest';
import { MiCallError } from './errors.js';
import { RingBuffer, StructuredLogger } from './logging.js';

describe('structured diagnostics', () => {
  it('keeps only the configured number of entries', () => {
    const buffer = new RingBuffer<number>(2);
    buffer.push(1);
    buffer.push(2);
    buffer.push(3);
    expect(buffer.values()).toEqual([2, 3]);
  });

  it('redacts credentials, authorization and SDP secrets', () => {
    const logger = new StructuredLogger({ scope: 'Security', minimumLevel: 'debug', now: () => 1 });
    logger.log('error', 'Authorization: Digest username="agent", response="secret"', {
      authorizationPassword: 'p@ssword',
      turnCredential: 'turn-secret',
      nested: { token: 'access-token' },
      body: 'v=0\r\na=ice-pwd:ice-secret\r\na=sendrecv',
    });

    const serialized = JSON.stringify(logger.exportDiagnostics());
    expect(serialized).not.toContain('p@ssword');
    expect(serialized).not.toContain('turn-secret');
    expect(serialized).not.toContain('access-token');
    expect(serialized).not.toContain('ice-secret');
    expect(serialized).not.toContain('response=');
    expect(serialized).toContain('[REDACTED]');
  });

  it('redacts sensitive keys in public error context', () => {
    const error = new MiCallError('CALL_FAILED', 'Safe public message.', {
      context: { authorizationPassword: 'secret', statusCode: 403 },
    });

    expect(error.context).toEqual({ authorizationPassword: '[REDACTED]', statusCode: 403 });
    expect(JSON.stringify(error.context)).not.toContain('secret');
  });
});
