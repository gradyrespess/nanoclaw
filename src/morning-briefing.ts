import { google } from 'googleapis';
import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from './config.js';
import { createGoogleAuth, DEFAULT_GOOGLE_TOKEN_PATH } from './google-auth.js';
import {
  getRouterState,
  setRouterState,
  getAllRegisteredGroups,
} from './db.js';
import { logger } from './logger.js';

const BRIEFING_CRON = '30 7 * * *'; // 7:30am every day
const SHEETS_ID = '1XfQBEUbvf9JYpVgXlG6GGvKqhElG5B2OAgHgk-luT4M';
const SHEETS_RANGE = 'Sheet1!A:D';
const OWM_LAT = 34.0007;
const OWM_LON = -81.0348;

const DUE_KEYWORDS = /\b(due|assignment|quiz|exam|hw|homework)\b/i;
const EXAM_KEYWORDS = /\b(exam|midterm|final|test)\b/i;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** "Monday March 22" */
function fmtFullDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: TIMEZONE,
  });
}

/** "11:20am" */
function fmtTime(isoStr: string): string {
  const d = new Date(isoStr);
  return d
    .toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: TIMEZONE,
    })
    .replace(' ', '') // "11:20 AM" → "11:20AM"
    .toLowerCase(); // → "11:20am"
}

/** "Mon Mar 25" */
function fmtShortDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: TIMEZONE,
  });
}

/** YYYY-MM-DD in local timezone */
function localDateStr(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

/** Start of a given local day as a Date (midnight) */
function startOfDay(d: Date): Date {
  const s = new Date(d);
  s.setFullYear(
    parseInt(localDateStr(d).slice(0, 4), 10),
    parseInt(localDateStr(d).slice(5, 7), 10) - 1,
    parseInt(localDateStr(d).slice(8, 10), 10),
  );
  s.setHours(0, 0, 0, 0);
  return s;
}

// ---------------------------------------------------------------------------
// MorningBriefing
// ---------------------------------------------------------------------------

export class MorningBriefing {
  private auth: any;
  private sendMessage: (jid: string, text: string) => Promise<void>;
  private extraJids: string[];

  constructor(
    sendMessage: (jid: string, text: string) => Promise<void>,
    extraJids: string[] = [],
    tokenPath: string = DEFAULT_GOOGLE_TOKEN_PATH,
  ) {
    this.sendMessage = sendMessage;
    this.extraJids = extraJids;
    this.auth = createGoogleAuth(tokenPath);
  }

  start(): void {
    this.schedulerLoop().catch((err) =>
      logger.error({ err }, 'Morning briefing scheduler crashed'),
    );
    logger.info('Morning briefing scheduler started');
  }

  private async schedulerLoop(): Promise<void> {
    while (true) {
      const next = CronExpressionParser.parse(BRIEFING_CRON, {
        tz: TIMEZONE,
      }).next();
      const delay = next.getTime() - Date.now();
      logger.info(
        { next: next.toISOString(), delayMs: delay },
        'Morning briefing scheduled',
      );
      await sleep(delay);
      try {
        await this.sendBriefing();
      } catch (err) {
        logger.error({ err }, 'Morning briefing send error');
      }
    }
  }

  // ── Weather ───────────────────────────────────────────────────────────────

  private async fetchWeather(): Promise<string | null> {
    const apiKey = process.env.OPENWEATHER_API_KEY;
    if (!apiKey) {
      logger.warn('OPENWEATHER_API_KEY not set — skipping weather section');
      return null;
    }
    const url =
      `https://api.openweathermap.org/data/2.5/weather` +
      `?lat=${OWM_LAT}&lon=${OWM_LON}&appid=${apiKey}&units=imperial`;

    const res = await fetch(url);
    if (!res.ok) {
      logger.warn({ status: res.status }, 'OpenWeatherMap request failed');
      return null;
    }
    const data = (await res.json()) as any;
    const temp = Math.round(data.main?.temp ?? 0);
    const high = Math.round(data.main?.temp_max ?? temp);
    const desc = data.weather?.[0]?.description ?? 'unknown';
    const descCapitalized = desc.charAt(0).toUpperCase() + desc.slice(1);
    return `${temp}°F, ${descCapitalized}. High ${high}°F.`;
  }

  // ── Calendar ──────────────────────────────────────────────────────────────

  private async fetchCalendarEvents(
    timeMin: Date,
    timeMax: Date,
  ): Promise<any[]> {
    const calendar = google.calendar({ version: 'v3', auth: this.auth });
    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
    });
    return (res.data.items || []).filter((e: any) => e.status !== 'cancelled');
  }

  // ── Spending this week (from Sheets) ──────────────────────────────────────

  private async fetchWeeklySpending(): Promise<{
    total: number;
    count: number;
  }> {
    const sheets = google.sheets({ version: 'v4', auth: this.auth });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEETS_ID,
      range: SHEETS_RANGE,
    });

    const rows = response.data.values || [];
    const now = new Date();

    // Monday of current week
    const dayOfWeek = now.getDay(); // 0=Sun … 6=Sat
    const monday = new Date(now);
    monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
    monday.setHours(0, 0, 0, 0);

    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);

    const currentYear = now.getFullYear();
    let total = 0;
    let count = 0;

    for (const row of rows) {
      if (!row[0] || !row[2]) continue;
      const parts = String(row[0]).split('/');
      if (parts.length < 2) continue;
      const month = parseInt(parts[0], 10) - 1;
      const day = parseInt(parts[1], 10);
      if (isNaN(month) || isNaN(day)) continue;
      const txDate = new Date(currentYear, month, day);
      if (txDate < monday || txDate > sunday) continue;
      const amount = parseFloat(String(row[2]));
      if (!isNaN(amount)) {
        total += amount;
        count++;
      }
    }

    return { total, count };
  }

  // ── Build and send ────────────────────────────────────────────────────────

  private getMainGroupJid(): string | null {
    const groups = getAllRegisteredGroups();
    const entry = Object.entries(groups).find(([, g]) => g.isMain === true);
    return entry ? entry[0] : null;
  }

  async sendBriefing(): Promise<void> {
    const now = new Date();
    const todayStr = localDateStr(now);

    // Idempotency — don't send twice in the same day
    const lastSent = getRouterState('morning_briefing_date');
    if (lastSent === todayStr) return;

    const mainJid = this.getMainGroupJid();
    if (!mainJid) {
      logger.warn('Morning briefing: no main group JID found');
      return;
    }

    const sections: string[] = [];

    // Header
    sections.push(
      `☀️ Good morning Grady! Here's your day — ${fmtFullDate(now)}`,
    );

    // ── Weather ───────────────────────────────────────────────────────────
    try {
      const weather = await this.fetchWeather();
      if (weather) sections.push(`\n🌤 Weather: ${weather}`);
    } catch (err) {
      logger.warn({ err }, 'Morning briefing: weather fetch failed');
    }

    // ── Calendar setup ────────────────────────────────────────────────────
    const todayStart = startOfDay(now);
    const todayEnd = new Date(todayStart);
    todayEnd.setDate(todayEnd.getDate() + 1);

    const tomorrowStart = new Date(todayEnd);
    const tomorrowEnd = new Date(tomorrowStart);
    tomorrowEnd.setDate(tomorrowEnd.getDate() + 1);

    const weekEnd = new Date(now);
    weekEnd.setDate(weekEnd.getDate() + 7);

    let todayEvents: any[] = [];
    let weekEvents: any[] = [];

    try {
      [todayEvents, weekEvents] = await Promise.all([
        this.fetchCalendarEvents(todayStart, todayEnd),
        this.fetchCalendarEvents(tomorrowStart, weekEnd),
      ]);
    } catch (err) {
      logger.warn({ err }, 'Morning briefing: calendar fetch failed');
    }

    // ── Today's Schedule (timed events, not due/assignment) ───────────────
    const timedToday = todayEvents.filter(
      (e) => e.start?.dateTime && !DUE_KEYWORDS.test(e.summary ?? ''),
    );
    if (timedToday.length > 0) {
      const lines = timedToday.map(
        (e) => `  ${fmtTime(e.start.dateTime)} — ${e.summary ?? '(no title)'}`,
      );
      sections.push(`\n📅 Today's Schedule:\n${lines.join('\n')}`);
    }

    // ── Today's Events (all-day, not due/assignment) ──────────────────────
    const allDayToday = todayEvents.filter(
      (e) => e.start?.date && !DUE_KEYWORDS.test(e.summary ?? ''),
    );
    if (allDayToday.length > 0) {
      const lines = allDayToday.map((e) => `  ${e.summary ?? '(no title)'}`);
      sections.push(`\n📌 Today's Events:\n${lines.join('\n')}`);
    }

    // ── Due Today ─────────────────────────────────────────────────────────
    const dueToday = todayEvents.filter((e) =>
      DUE_KEYWORDS.test(e.summary ?? ''),
    );
    if (dueToday.length > 0) {
      const lines = dueToday.map((e) => `  ${e.summary ?? '(no title)'}`);
      sections.push(`\n📚 Due Today:\n${lines.join('\n')}`);
    }

    // ── Due Tomorrow ──────────────────────────────────────────────────────
    let tomorrowEvents: any[] = [];
    try {
      tomorrowEvents = await this.fetchCalendarEvents(
        tomorrowStart,
        tomorrowEnd,
      );
    } catch (err) {
      logger.warn({ err }, 'Morning briefing: tomorrow calendar fetch failed');
    }
    const dueTomorrow = tomorrowEvents.filter((e) =>
      DUE_KEYWORDS.test(e.summary ?? ''),
    );
    if (dueTomorrow.length > 0) {
      const lines = dueTomorrow.map((e) => `  ${e.summary ?? '(no title)'}`);
      sections.push(`\n📚 Due Tomorrow:\n${lines.join('\n')}`);
    }

    // ── Exams This Week ───────────────────────────────────────────────────
    const examsThisWeek = weekEvents.filter((e) =>
      EXAM_KEYWORDS.test(e.summary ?? ''),
    );
    if (examsThisWeek.length > 0) {
      const lines = examsThisWeek.map((e) => {
        const dateStr = e.start?.dateTime
          ? fmtShortDate(new Date(e.start.dateTime))
          : e.start?.date
            ? fmtShortDate(new Date(e.start.date + 'T12:00:00'))
            : '?';
        return `  ${dateStr} — ${e.summary ?? '(no title)'}`;
      });
      sections.push(`\n🗓 Exams This Week:\n${lines.join('\n')}`);
    }

    // ── Spending This Week ────────────────────────────────────────────────
    try {
      const { total, count } = await this.fetchWeeklySpending();
      if (count > 0) {
        sections.push(
          `\n💸 Spent this week: $${total.toFixed(2)} across ${count} transaction${count === 1 ? '' : 's'}`,
        );
      }
    } catch (err) {
      logger.warn({ err }, 'Morning briefing: Sheets fetch failed');
    }

    const message = sections.join('');

    const jids = [mainJid, ...this.extraJids];
    for (const jid of jids) {
      try {
        await this.sendMessage(jid, message);
      } catch (err) {
        logger.error({ err, jid }, 'Failed to send morning briefing');
      }
    }

    setRouterState('morning_briefing_date', todayStr);
    logger.info({ jids }, 'Morning briefing sent');
  }
}
