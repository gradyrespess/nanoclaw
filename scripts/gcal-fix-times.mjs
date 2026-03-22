#!/usr/bin/env node
/**
 * Fix all-day NanoClaw events → 11:59 PM ET timed events.
 * Run after gcal-cleanup.mjs (which handles duplicates separately).
 *
 * Run: node scripts/gcal-fix-times.mjs [--dry-run]
 */
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');
if (DRY_RUN) console.log('*** DRY RUN — no changes will be made ***\n');

const TOKEN_PATH = path.join(__dirname, '.gcal-token.json');
const OAUTH_CREDS = {
  client_id: process.env.GOOGLE_CLIENT_ID,
  client_secret: process.env.GOOGLE_CLIENT_SECRET,
  redirect_uri: 'http://localhost:3456',
};
const SEMESTER_START = '2026-01-12T00:00:00-05:00';
const SEMESTER_END   = '2026-05-10T23:59:59-04:00';
const NANOCLAW_MARKER = 'Course:';

// DST in 2026: clocks spring forward Mar 8 at 2am
const DST_START = new Date('2026-03-08T07:00:00Z');

function easternOffset(dateStr) {
  // Returns -05:00 (EST) or -04:00 (EDT) for a given YYYY-MM-DD
  const d = new Date(dateStr + 'T00:00:00Z');
  return d >= DST_START ? '-04:00' : '-05:00';
}

function toEasternDateTime(dateStr, time = '23:59:00') {
  return `${dateStr}T${time}${easternOffset(dateStr)}`;
}

async function getAuth() {
  const auth = new google.auth.OAuth2(
    OAUTH_CREDS.client_id, OAUTH_CREDS.client_secret, OAUTH_CREDS.redirect_uri,
  );
  const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  auth.setCredentials(tokens);
  if (tokens.expiry_date && tokens.expiry_date < Date.now() + 60_000) {
    console.log('Refreshing token...');
    const { credentials } = await auth.refreshAccessToken();
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(credentials));
    auth.setCredentials(credentials);
  }
  return auth;
}

async function main() {
  const auth = await getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const calList = await calendar.calendarList.list();
  const primary = calList.data.items?.find(c => c.primary) || { id: 'primary' };
  const calId = primary.id;
  console.log(`Calendar: ${primary.summary} (${calId})\n`);

  // Fetch all NanoClaw events
  console.log('Fetching Spring 2026 NanoClaw events...');
  const events = [];
  let pageToken;
  do {
    const res = await calendar.events.list({
      calendarId: calId,
      timeMin: SEMESTER_START,
      timeMax: SEMESTER_END,
      maxResults: 2500,
      singleEvents: true,
      orderBy: 'startTime',
      pageToken,
    });
    for (const ev of res.data.items || []) {
      if (ev.description?.includes(NANOCLAW_MARKER)) events.push(ev);
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  const allDay = events.filter(ev => ev.start?.date && !ev.start?.dateTime);
  console.log(`Found ${events.length} NanoClaw events, ${allDay.length} are all-day.\n`);

  let fixed = 0;
  let errors = 0;

  for (const ev of allDay) {
    const dateStr = ev.start.date; // YYYY-MM-DD
    const startDT = toEasternDateTime(dateStr, '23:59:00');
    const endDT   = toEasternDateTime(dateStr, '23:59:59');

    process.stdout.write(`  Fixing: "${ev.summary}" (${dateStr}) → 11:59 PM ET`);

    if (!DRY_RUN) {
      try {
        // Must use update (PUT), not patch (PATCH).
        // Patch leaves start.date intact, which conflicts with start.dateTime.
        // We build a full event body without any 'date' fields.
        const fullEvent = {
          summary: ev.summary,
          description: ev.description,
          location: ev.location,
          colorId: ev.colorId,
          reminders: ev.reminders,
          start: { dateTime: startDT },
          end:   { dateTime: endDT },
        };
        await calendar.events.update({
          calendarId: calId,
          eventId: ev.id,
          requestBody: fullEvent,
        });
        process.stdout.write(' ✓\n');
        fixed++;
      } catch (err) {
        process.stdout.write(` ✗ ${err.message}\n`);
        errors++;
      }
    } else {
      process.stdout.write(` [dry-run]\n`);
      fixed++;
    }
  }

  console.log(`\nDone. ${fixed} events updated to 11:59 PM ET, ${errors} errors.`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
