#!/usr/bin/env node
/**
 * Google Calendar cleanup script for NanoClaw-added Blackboard events.
 *
 * What it does:
 *   1. Fetches all Spring 2026 events identified as NanoClaw-added
 *   2. Finds and removes duplicate events (same title + same date)
 *   3. Upgrades all-day events to timed events at 11:59 PM ET
 *   4. Cross-checks due dates against live Blackboard data (if cookies valid)
 *   5. Prints a full audit report of every change made
 *
 * Run: node scripts/gcal-cleanup.mjs [--dry-run]
 *   --dry-run  Show what would change without touching the calendar
 */

import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');

if (DRY_RUN) console.log('*** DRY RUN — no changes will be made ***\n');

// ── Config ────────────────────────────────────────────────────────────────────
const TOKEN_PATH = path.join(__dirname, '.gcal-token.json');
const OAUTH_CREDS = {
  client_id: process.env.GOOGLE_CLIENT_ID,
  client_secret: process.env.GOOGLE_CLIENT_SECRET,
  redirect_uri: 'http://localhost:3456',
};

// Semester window — search events in this range
const SEMESTER_START = '2026-01-12T00:00:00-05:00';
const SEMESTER_END   = '2026-05-10T23:59:59-04:00';

// NanoClaw events are identified by this string in the description
const NANOCLAW_MARKER = 'Course:';

// Default due time when no specific time is set
const DEFAULT_DUE_TIME = '23:59:00'; // 11:59 PM
const TIMEZONE = 'America/New_York';

// Blackboard session (may be expired — cleanup proceeds without it if so)
const BB_HOST = 'https://blackboard.sc.edu';
const BB_COOKIE = [
  'JSESSIONID=1C64F34D488E2589342D14A9EDC925BC',
  'BbRouter=expires:1773949141,id:FC1E6C643F887CE54B9350524027ED3E,sessionId:11819598832,signature:0f4778656a2be671b298313b46a8a3d3a30d14f150c2f35b475b392d576a7598,site:766aa328-09bf-43ed-a864-d73603bada75,timeout:10800,user:7bf1987137c34c14943edd7785a42ea6,v:2,xsrf:e62876eb-cba5-48a9-989b-7b55b86c8580',
].join('; ');

// USC Spring 2026 holidays / breaks (no classes on these dates)
const NO_CLASS_DATES = new Set([
  '2026-01-19', // MLK Day
  '2026-03-16', // Spring Break start
  '2026-03-17',
  '2026-03-18',
  '2026-03-19',
  '2026-03-20',
  '2026-03-21',
  '2026-03-22',
  '2026-05-04', // Reading Day
]);

// ── Auth ──────────────────────────────────────────────────────────────────────
async function getAuth() {
  const auth = new google.auth.OAuth2(
    OAUTH_CREDS.client_id,
    OAUTH_CREDS.client_secret,
    OAUTH_CREDS.redirect_uri,
  );

  if (!fs.existsSync(TOKEN_PATH)) {
    console.error('No token found at', TOKEN_PATH);
    console.error('Run scripts/bb-to-gcal.mjs first to authorize.');
    process.exit(1);
  }

  const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  auth.setCredentials(tokens);

  // Refresh if expired
  if (tokens.expiry_date && tokens.expiry_date < Date.now() + 60_000) {
    console.log('Refreshing Google access token...');
    const { credentials } = await auth.refreshAccessToken();
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(credentials));
    auth.setCredentials(credentials);
    console.log('Token refreshed.\n');
  }

  return auth;
}

// ── Calendar helpers ──────────────────────────────────────────────────────────
async function getAllNanoclawEvents(calendar, calendarId) {
  console.log('Fetching Spring 2026 events from Google Calendar...');
  const events = [];
  let pageToken;

  do {
    const res = await calendar.events.list({
      calendarId,
      timeMin: SEMESTER_START,
      timeMax: SEMESTER_END,
      maxResults: 2500,
      singleEvents: true,
      orderBy: 'startTime',
      pageToken,
    });

    for (const ev of res.data.items || []) {
      if (ev.description && ev.description.includes(NANOCLAW_MARKER)) {
        events.push(ev);
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  console.log(`Found ${events.length} NanoClaw-added events.\n`);
  return events;
}

function getEventDate(ev) {
  // Returns YYYY-MM-DD regardless of whether the event is timed or all-day
  return (ev.start?.dateTime || ev.start?.date || '').slice(0, 10);
}

function isAllDay(ev) {
  return !!ev.start?.date && !ev.start?.dateTime;
}

function dedupeKey(ev) {
  // Normalize title: strip trailing "(X pts)" for comparison
  const title = (ev.summary || '').replace(/\s*\(\d+(\.\d+)?\s*pts\)\s*$/, '').trim().toLowerCase();
  const date = getEventDate(ev);
  return `${title}|${date}`;
}

// ── Blackboard helpers ────────────────────────────────────────────────────────
async function fetchBbAssignments() {
  try {
    const res = await fetch(
      `${BB_HOST}/learn/api/public/v1/users/me/courses?limit=100&fields=courseId,course.courseId,course.name`,
      {
        headers: { Cookie: BB_COOKIE, 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const spring = (data.results || []).filter(m => m.course?.courseId?.includes('SPRING-2026'));

    const all = [];
    for (const m of spring) {
      const gr = await fetch(
        `${BB_HOST}/learn/api/public/v1/courses/${m.courseId}/gradebook/columns?limit=100`,
        { headers: { Cookie: BB_COOKIE, Accept: 'application/json' } },
      );
      if (!gr.ok) continue;
      const gd = await gr.json();
      for (const col of gd.results || []) {
        if (col.grading?.type === 'Calculated') continue;
        const due = col.grading?.due ? new Date(col.grading.due).toISOString().slice(0, 10) : null;
        all.push({ name: col.name, due, course: m.course.name });
      }
    }
    return all;
  } catch {
    return null;
  }
}

// ── Main cleanup ──────────────────────────────────────────────────────────────
async function main() {
  const auth = await getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  // Find primary calendar
  const calList = await calendar.calendarList.list();
  const primary = calList.data.items?.find(c => c.primary) || { id: 'primary', summary: 'primary' };
  const calId = primary.id;
  console.log(`Calendar: ${primary.summary} (${calId})\n`);

  // Fetch all NanoClaw events
  const events = await getAllNanoclawEvents(calendar, calId);

  if (events.length === 0) {
    console.log('No NanoClaw events found — nothing to clean up.');
    return;
  }

  // Try to fetch live Blackboard data for date verification
  console.log('Attempting Blackboard connection for date verification...');
  const bbData = await fetchBbAssignments();
  if (bbData) {
    console.log(`Connected to Blackboard — fetched ${bbData.length} assignments.\n`);
  } else {
    console.log('Blackboard session is expired — skipping date cross-check.\n');
  }

  // Build Blackboard lookup: normalized title → { due, course }
  const bbLookup = new Map();
  if (bbData) {
    for (const a of bbData) {
      bbLookup.set(a.name.trim().toLowerCase(), a);
    }
  }

  // ── Step 1: Find duplicates ────────────────────────────────────────────────
  console.log('=== Step 1: Duplicate Detection ===');
  const byKey = new Map(); // dedupeKey → [event, ...]
  for (const ev of events) {
    const k = dedupeKey(ev);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(ev);
  }

  const duplicateGroups = [...byKey.values()].filter(g => g.length > 1);
  console.log(`Found ${duplicateGroups.length} duplicate group(s) across ${events.length} events.\n`);

  const deleted = [];
  const kept = [];

  for (const group of duplicateGroups) {
    // Keep the most recently created event (most likely to have correct data)
    group.sort((a, b) => (a.created || '').localeCompare(b.created || ''));
    const toKeep = group[group.length - 1];
    const toDelete = group.slice(0, -1);

    console.log(`  DUPLICATE: "${toKeep.summary}" on ${getEventDate(toKeep)}`);
    console.log(`    Keeping:  id=${toKeep.id} (created ${toKeep.created?.slice(0, 10)})`);

    for (const ev of toDelete) {
      console.log(`    Deleting: id=${ev.id} (created ${ev.created?.slice(0, 10)})`);
      if (!DRY_RUN) {
        await calendar.events.delete({ calendarId: calId, eventId: ev.id });
      }
      deleted.push({ title: ev.summary, date: getEventDate(ev), reason: 'duplicate' });
    }
    kept.push(toKeep.id);
  }

  // ── Step 2: Fix all-day → 11:59 PM timed events ───────────────────────────
  console.log('\n=== Step 2: Fixing Event Times (All-Day → 11:59 PM ET) ===');

  // Work on surviving events (not the deleted ones)
  const deletedIds = new Set(deleted.map((_, i) => {
    // Rebuild from the groups
    return null;
  }));
  const deletedEventIds = new Set(
    duplicateGroups.flatMap(g => g.slice(0, -1).map(ev => ev.id))
  );

  const survivingEvents = events.filter(ev => !deletedEventIds.has(ev.id));
  const allDayEvents = survivingEvents.filter(isAllDay);
  console.log(`${allDayEvents.length} all-day events need time correction.\n`);

  const corrected = [];
  const dateErrors = [];

  for (const ev of allDayEvents) {
    const dateStr = getEventDate(ev);
    const updatedStart = `${dateStr}T${DEFAULT_DUE_TIME}`;
    // End = same day, 1 minute later so calendar shows it as a point-in-time
    const updatedEnd   = `${dateStr}T23:59:59`;

    // Check against Blackboard for date accuracy
    const titleNorm = (ev.summary || '').replace(/\s*\(\d+(\.\d+)?\s*pts\)\s*$/, '').trim().toLowerCase();
    const bbEntry = bbLookup.get(titleNorm);
    let correctedDate = dateStr;
    let dateWasWrong = false;

    if (bbEntry && bbEntry.due && bbEntry.due !== dateStr) {
      console.log(`  DATE MISMATCH: "${ev.summary}"`);
      console.log(`    Calendar: ${dateStr}  →  Blackboard: ${bbEntry.due}`);
      correctedDate = bbEntry.due;
      dateWasWrong = true;
      dateErrors.push({
        title: ev.summary,
        calendarDate: dateStr,
        blackboardDate: bbEntry.due,
        course: bbEntry.course,
      });
    }

    const finalStart = `${correctedDate}T${DEFAULT_DUE_TIME}`;
    const finalEnd   = `${correctedDate}T23:59:59`;

    console.log(`  ${dateWasWrong ? 'FIX DATE+TIME' : 'FIX TIME'}: "${ev.summary}" → ${correctedDate} 11:59 PM`);

    if (!DRY_RUN) {
      await calendar.events.patch({
        calendarId: calId,
        eventId: ev.id,
        requestBody: {
          start: { dateTime: finalStart, timeZone: TIMEZONE },
          end:   { dateTime: finalEnd,   timeZone: TIMEZONE },
        },
      });
    }

    corrected.push({
      title: ev.summary,
      oldDate: dateStr,
      newDate: correctedDate,
      dateFixed: dateWasWrong,
    });
  }

  // ── Step 3: Check for events on holidays / spring break ───────────────────
  console.log('\n=== Step 3: Holiday / Spring Break Check ===');
  const onHoliday = survivingEvents.filter(ev => NO_CLASS_DATES.has(getEventDate(ev)));
  if (onHoliday.length === 0) {
    console.log('No events fall on holidays or spring break.\n');
  } else {
    console.log(`WARNING — ${onHoliday.length} event(s) fall on no-class dates:\n`);
    for (const ev of onHoliday) {
      console.log(`  ⚠️  "${ev.summary}" on ${getEventDate(ev)} (holiday/break)`);
      console.log(`       → Keeping as-is (due dates may still fall on breaks)`);
    }
    console.log('');
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log('CLEANUP SUMMARY' + (DRY_RUN ? ' (DRY RUN — no changes made)' : ''));
  console.log('═'.repeat(60));

  console.log(`\nTotal NanoClaw events found: ${events.length}`);
  console.log(`Duplicates deleted:           ${deleted.length}`);
  console.log(`Events with time fixed:       ${corrected.length}`);
  console.log(`Date corrections (BB mismatch): ${dateErrors.length}`);
  console.log(`Events on holidays/breaks:    ${onHoliday.length} (kept, dates may be correct)`);

  if (deleted.length > 0) {
    console.log('\nDeleted (duplicates):');
    for (const d of deleted) {
      console.log(`  - "${d.title}" on ${d.date}`);
    }
  }

  if (dateErrors.length > 0) {
    console.log('\nDate corrections applied:');
    for (const e of dateErrors) {
      console.log(`  - [${e.course}] "${e.title}"`);
      console.log(`      Was: ${e.calendarDate}  →  Now: ${e.blackboardDate}`);
    }
  }

  if (onHoliday.length > 0) {
    console.log('\nEvents on breaks (review manually):');
    for (const ev of onHoliday) {
      console.log(`  - "${ev.summary}" on ${getEventDate(ev)}`);
    }
  }

  if (!DRY_RUN && (deleted.length > 0 || corrected.length > 0)) {
    console.log('\nCalendar has been updated successfully.');
  }
}

main().catch(err => {
  console.error('\nFatal error:', err.message || err);
  process.exit(1);
});
