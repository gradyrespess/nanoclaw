#!/usr/bin/env node
/**
 * Re-authorize Google OAuth with Calendar + Sheets scopes.
 * Saves token to .gcal-token.json
 *
 * Run: node scripts/gcal-auth.mjs
 */

import { google } from 'googleapis';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = path.join(__dirname, '.gcal-token.json');

const OAUTH_CREDS = {
  client_id: process.env.GOOGLE_CLIENT_ID,
  client_secret: process.env.GOOGLE_CLIENT_SECRET,
  redirect_uri: 'http://localhost:3456',
};

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/gmail.readonly',
];

const auth = new google.auth.OAuth2(
  OAUTH_CREDS.client_id,
  OAUTH_CREDS.client_secret,
  OAUTH_CREDS.redirect_uri
);

const authUrl = auth.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent', // force re-consent to get refresh token with new scopes
});

console.log('\nOpen this URL in your browser:\n');
console.log(authUrl);
console.log('\nWaiting for redirect on http://localhost:3456 ...\n');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:3456');
  const code = url.searchParams.get('code');

  if (!code) {
    res.writeHead(400);
    res.end('Missing code parameter');
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<h2>Auth successful! You can close this tab.</h2>');
  server.close();

  try {
    const { tokens } = await auth.getToken(code);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    console.log('Token saved to', TOKEN_PATH);
    console.log('Scopes:', tokens.scope);
  } catch (err) {
    console.error('Failed to exchange code for token:', err.message);
    process.exit(1);
  }
});

server.listen(3456);
