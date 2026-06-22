// CSRF state for the Instagram OAuth round-trip. Shared between the route that
// starts the flow (the dashboard's authenticated endpoint, or /auth/instagram)
// and the callback that finishes it. In-memory is sufficient: the flow is a
// single short browser round-trip and the free deployment is one instance.
const STATE_TTL_MS = 10 * 60 * 1000;
const pending = new Map<string, number>();

export function rememberState(state: string): void {
  pending.set(state, Date.now() + STATE_TTL_MS);
}

export function consumeState(state: string): boolean {
  const expiry = pending.get(state);
  if (expiry === undefined) return false;
  pending.delete(state);
  return expiry > Date.now();
}
