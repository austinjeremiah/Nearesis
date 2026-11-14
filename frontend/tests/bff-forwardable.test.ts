import { describe, it, expect } from 'vitest';
import { isForwardable } from '@/lib/auth/forwardable';

describe('BFF forwardable paths', () => {
  it('allows ordinary API paths', () => {
    expect(isForwardable('workspaces')).toBe(true);
    expect(isForwardable('workspaces/17cd0234-3625-49b9-9daa-97293bb3ecd7/runs')).toBe(true);
    expect(isForwardable('analytics/panel/abc123')).toBe(true);
  });
  it('refuses traversal and encoded separators', () => {
    for (const p of ['../x', 'workspaces/../auth', 'a/%2e%2e/b', 'a%2Fb/c', 'a//b', '', 'a/./b', 'a\\b', 'a/%5Cb']) expect(isForwardable(p), p).toBe(false);
  });
  it('refuses the routes the BFF owns', () => {
    for (const p of ['dev/login', 'session/revoke', 'auth/callback', 'auth', 'gateway/runs/x', 'auth/near/verify', 'auth/near/challenge', 'auth/near/link/x']) expect(isForwardable(p), p).toBe(false);
  });
  it('forwards the authenticated wallet link', () => {
    expect(isForwardable('auth/near/link')).toBe(true);
  });
});
