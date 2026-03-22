import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

const OAUTH_CLIENT_ID =
  '103337039969-r3l429rdkvs2ndul3sujmvecmh8amtri.apps.googleusercontent.com';
const OAUTH_CLIENT_SECRET = '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';
const OAUTH_REDIRECT_URI = 'http://localhost:3456';

export const DEFAULT_GOOGLE_TOKEN_PATH =
  process.env.GOOGLE_TOKEN_PATH ||
  path.join(process.cwd(), 'scripts', '.gcal-token.json');

/**
 * Build a Google OAuth2 client from the persisted token file.
 * Automatically writes back refreshed tokens when they expire.
 */
export function createGoogleAuth(
  tokenPath: string = DEFAULT_GOOGLE_TOKEN_PATH,
): any {
  if (!fs.existsSync(tokenPath)) {
    throw new Error(
      `Google token not found at ${tokenPath}. Run scripts/gcal-auth.mjs first.`,
    );
  }

  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));

  const auth = new google.auth.OAuth2(
    OAUTH_CLIENT_ID,
    OAUTH_CLIENT_SECRET,
    OAUTH_REDIRECT_URI,
  );
  auth.setCredentials(token);

  // Persist refreshed tokens automatically
  auth.on('tokens', (tokens: any) => {
    try {
      const current = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      fs.writeFileSync(
        tokenPath,
        JSON.stringify({ ...current, ...tokens }, null, 2),
      );
      logger.info('Google OAuth token auto-refreshed');
    } catch (err) {
      logger.warn({ err }, 'Failed to save refreshed Google token');
    }
  });

  return auth;
}
