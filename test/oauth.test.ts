import { describe, expect, it } from 'vitest';
import { buildAuthorizeUrl, isOAuthConfigured } from '../src/services/instagram/oauth';

describe('Instagram OAuth', () => {
  it('reports configured when app id/secret/redirect are present', () => {
    expect(isOAuthConfigured()).toBe(true);
  });

  it('builds an authorize URL with the required params', () => {
    const url = new URL(buildAuthorizeUrl('state-123'));
    expect(url.origin + url.pathname).toBe('https://www.instagram.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('test-ig-app-id');
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.onrender.com/auth/instagram/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('scope')).toContain('instagram_business_manage_messages');
  });
});
