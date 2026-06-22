import { describe, expect, it } from 'vitest';
import { isWithinStandardWindow } from '../src/services/instagram/client';

describe('isWithinStandardWindow', () => {
  const now = Date.parse('2026-01-02T12:00:00Z');

  it('is true within 24h of the customer message', () => {
    expect(isWithinStandardWindow(new Date(now - 3_600_000).toISOString(), now)).toBe(true);
  });

  it('is false after 24h', () => {
    expect(isWithinStandardWindow(new Date(now - 25 * 3_600_000).toISOString(), now)).toBe(false);
  });

  it('is false when there is no customer message on record', () => {
    expect(isWithinStandardWindow(null, now)).toBe(false);
  });
});
