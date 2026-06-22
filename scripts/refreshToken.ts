import { logger } from '../src/lib/logger';
import { refreshLongLivedToken } from '../src/services/instagram/oauth';
import { getStoredCredentials, saveCredentials } from '../src/services/instagram/tokenStore';

// Manually refresh the stored long-lived Instagram token. The running server
// also does this automatically; this script is for one-off use.
//
//   npm run refresh-token
async function main() {
  const creds = await getStoredCredentials();
  const current = creds?.accessToken ?? process.env.IG_ACCESS_TOKEN;
  if (!current) {
    process.stderr.write('No stored Instagram token to refresh. Connect first via /auth/instagram.\n');
    process.exit(1);
  }

  const refreshed = await refreshLongLivedToken(current);
  const expiresAt = refreshed.expiresInSeconds
    ? new Date(Date.now() + refreshed.expiresInSeconds * 1000).toISOString()
    : null;
  await saveCredentials({
    igUserId: creds?.igUserId ?? null,
    accessToken: refreshed.accessToken,
    tokenType: refreshed.tokenType,
    expiresAt,
  });
  logger.info({ expiresAt }, 'refreshed and stored Instagram token');
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, 'token refresh failed');
  process.exit(1);
});
