import { env } from '../src/config/env';

// Refresh the long-lived Instagram access token. Instagram Login long-lived
// tokens last ~60 days and can be refreshed any time after they are 24h old.
// Run this on a schedule (well before expiry), then update IG_ACCESS_TOKEN in
// the deployment environment with the printed value.
//
//   npm run refresh-token
//
// The new token is written to stdout intentionally (so you can copy it). Treat
// that output as a secret.
async function main() {
  const url =
    `${env.GRAPH_BASE}/refresh_access_token` +
    `?grant_type=ig_refresh_token&access_token=${encodeURIComponent(env.IG_ACCESS_TOKEN)}`;

  const res = await fetch(url);
  const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: unknown };

  if (!res.ok || !body.access_token) {
    process.stderr.write(`Token refresh failed (${res.status}): ${JSON.stringify(body)}\n`);
    process.exit(1);
  }

  const days = body.expires_in ? Math.round(body.expires_in / 86_400) : null;
  process.stdout.write(`New IG_ACCESS_TOKEN:\n${body.access_token}\n`);
  if (days !== null) process.stdout.write(`Expires in ~${days} days.\n`);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`Token refresh error: ${String(err)}\n`);
  process.exit(1);
});
