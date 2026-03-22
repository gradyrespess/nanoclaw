#!/usr/bin/env node
/**
 * Blackboard → Google Calendar sync
 * Uses a Playwright-based CAS login (scripts/bb-login.mjs) to authenticate.
 * Session cookies are cached in scripts/.bb-session.json for up to 2.5 hours.
 *
 * Usage:
 *   node scripts/bb-to-gcal.mjs             # login via stdin Duo prompt if needed
 *   node scripts/bb-to-gcal.mjs --discord   # login with Discord Duo approval flow
 */

import { google } from 'googleapis';
import http from 'http';
import { URL } from 'url';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────
const BB_HOST         = 'https://blackboard.sc.edu';
const BB_USER_AGENT   = 'Mozilla/5.0 (compatible; NanoClaw/1.0)';
const BB_SESSION_FILE = path.join(__dirname, '.bb-session.json');
const TOKEN_PATH      = path.join(__dirname, '.gcal-token.json');
const LOGIN_SCRIPT    = path.join(__dirname, 'bb-login.mjs');

// Session is valid for 2.5 hours (Blackboard idle timeout is 3h)
const SESSION_MAX_AGE_MS = 2.5 * 60 * 60 * 1000;

const OAUTH_CREDS = {
  client_id:    process.env.GOOGLE_CLIENT_ID,
  client_secret:process.env.GOOGLE_CLIENT_SECRET,
  redirect_uri: 'http://localhost:3456',
};

const SEMESTER_FILTER = 'SPRING-2026';
const USE_DISCORD     = process.argv.includes('--discord');

// ── Blackboard session management ─────────────────────────────────────────────

function loadSession() {
  if (!fs.existsSync(BB_SESSION_FILE)) return null;
  try {
    const session = JSON.parse(fs.readFileSync(BB_SESSION_FILE, 'utf8'));
    const age = Date.now() - new Date(session.saved_at).getTime();
    if (age > SESSION_MAX_AGE_MS) {
      console.log(`  ⏰ Session expired (${Math.round(age / 60000)} min old) — re-login needed`);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

function runLogin() {
  console.log('🔐 Running Blackboard CAS login...');
  const args = ['scripts/bb-login.mjs'];
  if (USE_DISCORD) args.push('--discord');
  execFileSync(process.execPath, args, {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    env: process.env,
  });
}

async function ensureSession() {
  let session = loadSession();
  if (!session) {
    runLogin();
    session = loadSession();
    if (!session) throw new Error('Login succeeded but session file not found');
  }
  return session.cookies;
}

// ── Blackboard REST API ───────────────────────────────────────────────────────

let _bbCookies = null;

async function bbJson(urlPath, retried = false) {
  const res = await fetch(`${BB_HOST}${urlPath}`, {
    headers: {
      Cookie:       _bbCookies,
      'User-Agent': BB_USER_AGENT,
      Accept:       'application/json',
    },
  });

  if ((res.status === 401 || res.status === 403) && !retried) {
    console.log('  🔄 Session rejected — refreshing via browser login...');
    // Force re-login by deleting the stale session file
    try { fs.unlinkSync(BB_SESSION_FILE); } catch {}
    runLogin();
    const session = loadSession();
    if (!session) throw new Error('Re-login failed');
    _bbCookies = session.cookies;
    return bbJson(urlPath, true);
  }

  if (!res.ok) throw new Error(`BB API ${urlPath} → ${res.status}`);
  return res.json();
}

async function getCourses() {
  console.log('📚 Fetching your courses...');
  const data = await bbJson(
    '/learn/api/public/v1/users/me/courses?limit=100&fields=courseId,course.courseId,course.name',
  );
  const filtered = (data.results || []).filter(m =>
    m.course?.courseId?.includes(SEMESTER_FILTER),
  );
  console.log(`  Found ${filtered.length} ${SEMESTER_FILTER} courses`);
  return filtered.map(m => ({ id: m.courseId, name: m.course.name, courseId: m.course.courseId }));
}

async function getCourseAssignments(course) {
  console.log(`  📋 ${course.name}`);
  const assignments = [];
  try {
    const data = await bbJson(
      `/learn/api/public/v1/courses/${course.id}/gradebook/columns?limit=100`,
    );
    for (const col of (data.results || [])) {
      if (col.grading?.type === 'Calculated') continue;
      const due = col.grading?.due ? new Date(col.grading.due).toISOString() : null;
      assignments.push({
        name:   col.name,
        due,
        points: col.score?.possible ?? null,
        course: course.name,
      });
    }
  } catch (e) {
    console.log(`     ⚠️  Could not fetch gradebook: ${e.message}`);
  }
  console.log(`     → ${assignments.length} item(s) found`);
  return assignments;
}

// ── Google OAuth ──────────────────────────────────────────────────────────────

function makeOAuth2Client() {
  return new google.auth.OAuth2(
    OAUTH_CREDS.client_id,
    OAUTH_CREDS.client_secret,
    OAUTH_CREDS.redirect_uri,
  );
}

async function getGoogleAuth() {
  const auth = makeOAuth2Client();

  if (fs.existsSync(TOKEN_PATH)) {
    const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    auth.setCredentials(tokens);
    if (tokens.expiry_date && tokens.expiry_date < Date.now() + 60000) {
      const { credentials } = await auth.refreshAccessToken();
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(credentials));
      auth.setCredentials(credentials);
    }
    return auth;
  }

  const url = auth.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
  });
  console.log('\n🔑 Open this URL to authorize Google Calendar:\n');
  console.log(url);
  console.log('\nWaiting for authorization...\n');

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const qs = new URL(req.url, 'http://localhost:3456').searchParams;
      const code = qs.get('code');
      if (code) {
        res.end('<h2>Authorized! You can close this tab.</h2>');
        server.close();
        resolve(code);
      } else {
        res.end('<h2>No code found.</h2>');
        reject(new Error('No OAuth code'));
      }
    });
    server.listen(3456);
  });

  const { tokens } = await auth.getToken(code);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
  auth.setCredentials(tokens);
  return auth;
}

// ── Google Calendar ───────────────────────────────────────────────────────────

async function fetchExistingEventKeys(calendar, calendarId) {
  const existing = new Map();
  let pageToken;
  do {
    const res = await calendar.events.list({
      calendarId,
      timeMin:      '2026-01-01T00:00:00-05:00',
      timeMax:      '2026-06-01T00:00:00-04:00',
      maxResults:   2500,
      singleEvents: true,
      pageToken,
    });
    for (const ev of res.data.items || []) {
      if (!ev.description?.includes('Course:')) continue;
      const titleNorm = (ev.summary || '')
        .replace(/\s*\(\d+(\.\d+)?\s*pts\)\s*$/, '')
        .trim()
        .toLowerCase();
      const date = (ev.start?.dateTime || ev.start?.date || '').slice(0, 10);
      existing.set(`${titleNorm}|${date}`, ev.id);
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return existing;
}

async function addToCalendar(auth, assignments) {
  const calendar = google.calendar({ version: 'v3', auth });

  const calList = await calendar.calendarList.list();
  const primary = calList.data.items?.find(c => c.primary) || { id: 'primary' };
  console.log(`\n📅 Syncing to calendar: ${primary.summary || 'primary'}`);

  console.log('  Checking existing events for duplicates...');
  const existingKeys = await fetchExistingEventKeys(calendar, primary.id);
  console.log(`  Found ${existingKeys.size} existing NanoClaw events.\n`);

  let added = 0, skipped = 0, duplicates = 0, errors = 0;

  for (const a of assignments) {
    if (!a.due) {
      console.log(`  ⚠️  No date for: "${a.name}" — skipping`);
      skipped++;
      continue;
    }

    const dateStr   = new Date(a.due).toISOString().slice(0, 10);

    // Skip placeholder dates far in the future (e.g. Blackboard default 2029-01-01)
    const dueYear = parseInt(dateStr.slice(0, 4), 10);
    if (dueYear > new Date().getFullYear() + 2) {
      console.log(`  ⚠️  Skipping far-future placeholder date: "${a.name}" on ${dateStr}`);
      skipped++;
      continue;
    }

    const title     = `${a.name}${a.points != null ? ` (${a.points} pts)` : ''}`;
    const titleNorm = a.name.trim().toLowerCase();
    const dedupeKey = `${titleNorm}|${dateStr}`;

    if (existingKeys.has(dedupeKey)) {
      console.log(`  ⏭  Already exists: "${title}" on ${dateStr}`);
      duplicates++;
      continue;
    }

    const description = `Course: ${a.course}\nSource: gradebook\nAdded by: NanoClaw`;
    try {
      const res = await calendar.events.insert({
        calendarId: primary.id,
        requestBody: {
          summary:     title,
          description,
          start:     { date: dateStr },
          end:       { date: dateStr },
          reminders: { useDefault: false, overrides: [] },
        },
      });
      existingKeys.set(dedupeKey, res.data.id);
      console.log(`  ✅ Added: "${title}" → ${dateStr}`);
      added++;
    } catch (e) {
      console.log(`  ❌ Failed to add "${title}": ${e.message}`);
      errors++;
    }
  }

  console.log(`\n🎉 Done! ${added} added, ${duplicates} already existed (skipped), ${skipped} had no date, ${errors} errors.`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🎓 Blackboard → Google Calendar Sync\n');

  // 1. Ensure a valid Blackboard session
  _bbCookies = await ensureSession();
  console.log('✅ Blackboard session ready\n');

  // 2. Google Calendar auth
  const auth = await getGoogleAuth();
  console.log('✅ Google authorized\n');

  // 3. Fetch courses
  const courses = await getCourses();
  if (!courses.length) {
    console.log(`❌ No ${SEMESTER_FILTER} courses found.`);
    process.exit(1);
  }

  // 4. Fetch assignments
  console.log('\n📖 Fetching assignments per course...');
  const allAssignments = [];
  for (const course of courses) {
    allAssignments.push(...await getCourseAssignments(course));
  }
  console.log(`\n📊 Total assignments found: ${allAssignments.length}`);

  // 5. Sync to Google Calendar
  await addToCalendar(auth, allAssignments);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
