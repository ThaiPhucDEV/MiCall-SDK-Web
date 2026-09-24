import { describe, expect, it } from 'vitest';
import type { Notification } from 'sip.js';
import { mapRejectedInvite, parseNotifyStatus } from './sip-js-signaling.js';

describe('outgoing INVITE final response mapping', () => {
  it.each([
    [408, 'no-answer'],
    [486, 'busy'],
    [603, 'declined'],
    [404, 'failed'],
    [500, 'failed'],
    [undefined, 'failed'],
  ] as const)('maps status %s to %s', (statusCode, reason) => {
    expect(mapRejectedInvite(statusCode)).toBe(reason);
  });
});

describe('REFER NOTIFY status parsing', () => {
  it.each([
    ['SIP/2.0 200 OK', 200],
    ['SIP/2.0 486 Busy Here', 486],
    ['invalid body', undefined],
  ] as const)('parses %s', (body, expected) => {
    const notification = { request: { body } } as unknown as Notification;
    expect(parseNotifyStatus(notification)).toBe(expected);
  });
});
