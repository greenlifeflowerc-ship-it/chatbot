import { describe, expect, it } from 'vitest';
import { extractInboundMessages, parseWebhookPayload } from '../src/services/instagram/parse';

const payload = {
  object: 'instagram',
  entry: [
    {
      id: 'biz',
      time: 1700000000,
      messaging: [
        { sender: { id: 'cust1' }, recipient: { id: 'biz' }, timestamp: 1700000001, message: { mid: 'm1', text: 'Hello' } },
        { sender: { id: 'biz' }, recipient: { id: 'cust1' }, message: { mid: 'm2', text: 'auto', is_echo: true } },
        { sender: { id: 'cust1' }, recipient: { id: 'biz' }, message: { mid: 'm3' } },
        { sender: { id: 'cust1' }, recipient: { id: 'biz' }, message: { mid: 'm4', text: '   ' } },
      ],
    },
  ],
};

describe('webhook parsing', () => {
  it('extracts only actionable inbound text messages', () => {
    const events = extractInboundMessages(parseWebhookPayload(payload));
    expect(events).toHaveLength(1);
    expect(events[0]?.eventKey).toBe('m1');
    expect(events[0]?.inbound.text).toBe('Hello');
    expect(events[0]?.inbound.senderId).toBe('cust1');
  });

  it('rejects a malformed payload', () => {
    expect(() => parseWebhookPayload({ not: 'a webhook' })).toThrow();
  });
});
