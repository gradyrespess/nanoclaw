#!/usr/bin/env node
/**
 * Adds Spring 2026 class meeting events to Google Calendar.
 *
 * Courses:
 *   ECON 321 – Intermediate Microeconomic Theory  (Tue/Thu 11:40–12:55, DMSB 141)
 *   POLI 302 – Classical & Medieval Political Theory (Mon/Wed 2:20–3:35, Gambrell 152)
 *   ENGL 360 – Creative Writing                   (Tue/Thu 10:05–11:20, HU 408)
 *   ACCT 324 – Survey of Commercial Law            (Tue/Thu 1:15–2:30, DMSB 101)
 *
 * Run: node scripts/gcal-add-classes.mjs [--dry-run]
 */

import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');

if (DRY_RUN) console.log('*** DRY RUN — no changes will be made ***\n');

// ── Auth ──────────────────────────────────────────────────────────────────────
const TOKEN_PATH = path.join(__dirname, '.gcal-token.json');
const OAUTH_CREDS = {
  client_id: '103337039969-r3l429rdkvs2ndul3sujmvecmh8amtri.apps.googleusercontent.com',
  client_secret: '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',
  redirect_uri: 'http://localhost:3456',
};

function getAuth() {
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  const auth = new google.auth.OAuth2(
    OAUTH_CREDS.client_id,
    OAUTH_CREDS.client_secret,
    OAUTH_CREDS.redirect_uri
  );
  auth.setCredentials(token);
  return auth;
}

// ── Class definitions ─────────────────────────────────────────────────────────
const TZ = 'America/New_York';

// Helper: format "YYYYMMDDTHHMMSS" for RRULE/EXDATE
function ical(dateStr, timeStr) {
  // dateStr: "2026-01-13", timeStr: "11:40:00"
  return dateStr.replace(/-/g, '') + 'T' + timeStr.replace(/:/g, '');
}

// Each entry: one recurring series
const CLASSES = [
  // ── ECON 321 ──────────────────────────────────────────────────────────────
  {
    summary: 'ECON 321 – Intermediate Microeconomic Theory',
    location: 'DMSB 141',
    description: 'Tue/Thu 11:40 AM – 12:55 PM | DMSB 141\nAdded by: NanoClaw',
    startDate: '2026-01-13', // first Tuesday
    startTime: '11:40:00',
    endTime:   '12:55:00',
    rrule: 'RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20260423T235959Z',
    exdates: ['2026-03-10'], // Spring Break
    dayLabel: 'Tuesday',
  },
  {
    summary: 'ECON 321 – Intermediate Microeconomic Theory',
    location: 'DMSB 141',
    description: 'Tue/Thu 11:40 AM – 12:55 PM | DMSB 141\nAdded by: NanoClaw',
    startDate: '2026-01-15', // first Thursday
    startTime: '11:40:00',
    endTime:   '12:55:00',
    rrule: 'RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20260423T235959Z',
    exdates: ['2026-02-05', '2026-03-12'], // Articles of Confederation Day, Spring Break
    dayLabel: 'Thursday',
  },

  // ── POLI 302 ──────────────────────────────────────────────────────────────
  {
    summary: 'POLI 302 – Classical & Medieval Political Theory',
    location: 'Gambrell 152',
    description: 'Mon/Wed 2:20 PM – 3:35 PM | Gambrell 152\nAdded by: NanoClaw',
    startDate: '2026-01-12', // first Monday
    startTime: '14:20:00',
    endTime:   '15:35:00',
    rrule: 'RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260427T235959Z',
    exdates: ['2026-01-19', '2026-02-02', '2026-03-09'], // MLK Day, Snow Day, Spring Break
    dayLabel: 'Monday',
  },
  {
    summary: 'POLI 302 – Classical & Medieval Political Theory',
    location: 'Gambrell 152',
    description: 'Mon/Wed 2:20 PM – 3:35 PM | Gambrell 152\nAdded by: NanoClaw',
    startDate: '2026-01-14', // first Wednesday
    startTime: '14:20:00',
    endTime:   '15:35:00',
    rrule: 'RRULE:FREQ=WEEKLY;BYDAY=WE;UNTIL=20260422T235959Z',
    exdates: ['2026-03-11'], // Spring Break
    dayLabel: 'Wednesday',
  },

  // ── ENGL 360 ──────────────────────────────────────────────────────────────
  {
    summary: 'ENGL 360 – Creative Writing',
    location: 'HU 408',
    description: 'Tue/Thu 10:05 AM – 11:20 AM | HU 408\nAdded by: NanoClaw',
    startDate: '2026-01-13', // first Tuesday
    startTime: '10:05:00',
    endTime:   '11:20:00',
    rrule: 'RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20260423T235959Z',
    exdates: ['2026-03-10'], // Spring Break
    dayLabel: 'Tuesday',
  },
  {
    summary: 'ENGL 360 – Creative Writing',
    location: 'HU 408',
    description: 'Tue/Thu 10:05 AM – 11:20 AM | HU 408\nAdded by: NanoClaw',
    startDate: '2026-01-15', // first Thursday
    startTime: '10:05:00',
    endTime:   '11:20:00',
    rrule: 'RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20260423T235959Z',
    exdates: ['2026-03-12'], // Spring Break
    dayLabel: 'Thursday',
  },

  // ── ACCT 324 ──────────────────────────────────────────────────────────────
  {
    summary: 'ACCT 324 – Survey of Commercial Law',
    location: 'DMSB 101',
    description: 'Tue/Thu 1:15 PM – 2:30 PM | DMSB 101\nAdded by: NanoClaw',
    startDate: '2026-01-13', // first Tuesday
    startTime: '13:15:00',
    endTime:   '14:30:00',
    rrule: 'RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20260423T235959Z',
    exdates: ['2026-03-10'], // Spring Break
    dayLabel: 'Tuesday',
  },
  {
    summary: 'ACCT 324 – Survey of Commercial Law',
    location: 'DMSB 101',
    description: 'Tue/Thu 1:15 PM – 2:30 PM | DMSB 101\nAdded by: NanoClaw',
    startDate: '2026-01-15', // first Thursday
    startTime: '13:15:00',
    endTime:   '14:30:00',
    rrule: 'RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20260423T235959Z',
    exdates: ['2026-03-12'], // Spring Break
    dayLabel: 'Thursday',
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  // Get primary calendar ID
  const calList = await calendar.calendarList.list({ maxResults: 1 });
  const primaryCal = calList.data.items.find(c => c.primary) || calList.data.items[0];
  const calendarId = primaryCal.id;
  console.log(`Using calendar: ${primaryCal.summary} (${calendarId})\n`);

  let created = 0;

  for (const cls of CLASSES) {
    // Build recurrence array: RRULE + optional EXDATEs
    const recurrence = [cls.rrule];
    if (cls.exdates && cls.exdates.length > 0) {
      const dates = cls.exdates.map(d => ical(d, cls.startTime)).join(',');
      recurrence.push(`EXDATE;TZID=${TZ}:${dates}`);
    }

    const event = {
      summary: cls.summary,
      location: cls.location,
      description: cls.description,
      start: {
        dateTime: `${cls.startDate}T${cls.startTime}`,
        timeZone: TZ,
      },
      end: {
        dateTime: `${cls.startDate}T${cls.endTime}`,
        timeZone: TZ,
      },
      recurrence,
    };

    console.log(`[${cls.dayLabel}] ${cls.summary}`);
    console.log(`  Start: ${cls.startDate} ${cls.startTime} → ${cls.endTime}`);
    console.log(`  RRULE: ${cls.rrule}`);
    if (cls.exdates.length) console.log(`  EXDATE: ${cls.exdates.join(', ')}`);

    if (!DRY_RUN) {
      const res = await calendar.events.insert({ calendarId, resource: event });
      console.log(`  ✓ Created: ${res.data.htmlLink}\n`);
      created++;
    } else {
      console.log(`  (dry run — skipped)\n`);
    }
  }

  console.log(`\nDone. ${DRY_RUN ? '0 (dry run)' : created} events created.`);

  if (!DRY_RUN) {
    console.log('\n⚠️  Note: BADM 301 was NOT added — meeting time/location unknown.');
    console.log('   Check your schedule in Self Service Carolina or contact the instructor.');
  }
}

main().catch(err => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
