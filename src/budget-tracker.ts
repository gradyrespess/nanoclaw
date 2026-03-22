import { google } from 'googleapis';
import fs from 'fs';
import { CronExpressionParser } from 'cron-parser';
import { logger } from './logger.js';
import { TIMEZONE } from './config.js';
import { createGoogleAuth, DEFAULT_GOOGLE_TOKEN_PATH } from './google-auth.js';
import {
  BudgetTransaction,
  getAllPendingBudgetTransactions,
  findPendingBudgetTransactionByMerchant,
  getBudgetTransactionByEmailId,
  getBudgetTransactionByShortId,
  getNextBudgetShortId,
  getPendingBudgetTransactions,
  getAllRegisteredGroups,
  getMessagesSince,
  getRouterState,
  saveBudgetTransaction,
  setBudgetTransactionPromptSent,
  setRouterState,
  updateBudgetTransactionStatus,
} from './db.js';

const CARD_ALERT_SENDER = 'CARDALERTS@smsservicesnow.com';
const SHEETS_ID = '1XfQBEUbvf9JYpVgXlG6GGvKqhElG5B2OAgHgk-luT4M';
const SHEETS_RANGE = 'Sheet1!A:D';
const GMAIL_POLL_MS = 60 * 60 * 1000;
const REPLY_POLL_MS = 15 * 1000;
const WEEKLY_SUMMARY_CRON = '0 20 * * 0'; // Every Sunday at 8pm

const CATEGORY_EMOJI: Record<string, string> = {
  Food: '🍔',
  Gas: '⛽',
  Shopping: '🛍️',
  Transport: '🚗',
  Entertainment: '🎬',
  Transfers: '💸',
  Other: '📦',
};

// ---------------------------------------------------------------------------
// Categorization
// ---------------------------------------------------------------------------

const CATEGORIES: Array<{ patterns: RegExp[]; label: string }> = [
  {
    patterns: [
      /venmo/i,
      /paypal/i,
      /zelle/i,
      /cash app/i,
      /cashapp/i,
      /apple cash/i,
    ],
    label: 'Transfers',
  },
  {
    patterns: [
      /chick.fil.a/i,
      /mcdonald/i,
      /subway/i,
      /chipotle/i,
      /pizza/i,
      /starbucks/i,
      /dunkin/i,
      /doordash/i,
      /grubhub/i,
      /uber eats/i,
      /ubereats/i,
      /restaurant/i,
      /burger/i,
      /taco/i,
      /wendy/i,
      /domino/i,
      /papa john/i,
      /panera/i,
      /waffle/i,
      /diner/i,
      /sushi/i,
      /bbq/i,
      /wings/i,
      /tropical smoothie/i,
      /smoothie/i,
    ],
    label: 'Food',
  },
  {
    patterns: [
      /shell/i,
      /\bbp\b/i,
      /exxon/i,
      /chevron/i,
      /mobil/i,
      /sunoco/i,
      /circle k/i,
      /speedway/i,
      /fuel/i,
      /gas station/i,
      /marathon/i,
      /racetrac/i,
      /murphy/i,
      /wawa/i,
      /sheetz/i,
    ],
    label: 'Gas',
  },
  {
    patterns: [
      /walmart/i,
      /target/i,
      /amazon/i,
      /best buy/i,
      /cvs/i,
      /walgreens/i,
      /dollar tree/i,
      /dollar general/i,
      /publix/i,
      /kroger/i,
      /costco/i,
      /sam.s club/i,
      /whole foods/i,
      /trader joe/i,
      /aldi/i,
      /ross/i,
      /tj maxx/i,
      /marshalls/i,
      /home depot/i,
      /lowe.s/i,
      /ikea/i,
    ],
    label: 'Shopping',
  },
  {
    patterns: [
      /amc/i,
      /netflix/i,
      /spotify/i,
      /hulu/i,
      /cinema/i,
      /theater/i,
      /theatre/i,
      /ticketmaster/i,
      /fandango/i,
      /xbox/i,
      /playstation/i,
      /steam/i,
      /apple.*sub/i,
      /apple.*music/i,
      /disney/i,
      /hbo/i,
      /paramount/i,
      /peacock/i,
    ],
    label: 'Entertainment',
  },
  {
    patterns: [
      /\buber\b/i,
      /lyft/i,
      /parking/i,
      /transit/i,
      /mta/i,
      /amtrak/i,
      /greyhound/i,
      /spirit air/i,
      /delta/i,
      /southwest/i,
      /american air/i,
      /united air/i,
    ],
    label: 'Transport',
  },
];

function categorize(merchant: string): string {
  for (const { patterns, label } of CATEGORIES) {
    if (patterns.some((p) => p.test(merchant))) return label;
  }
  return 'Other';
}

// ---------------------------------------------------------------------------
// Email parsing
// ---------------------------------------------------------------------------

interface ParsedTransaction {
  date: string;
  merchant: string;
  amount: number;
  category: string;
}

function parseCardAlert(body: string): ParsedTransaction | null {
  // Only process incoming charges ("Pending charge for ...")
  const match = body.match(
    /Pending charge for \$(\d+\.\d{2}) on (\d{2}\/\d{2}) [\d:]+ \w+ at (.+?) for Debit card/i,
  );
  if (!match) return null;

  const amount = parseFloat(match[1]);
  const date = match[2];
  // Merchant may include ", City, ST" — take only the name part
  const rawMerchant = match[3].trim();
  const merchant = rawMerchant.split(/,\s*/)[0].trim();
  const category = categorize(merchant);

  return { amount, date, merchant, category };
}

function extractBodyText(payload: any): string {
  if (!payload) return '';

  // Prefer text/plain parts
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractBodyText(part);
      if (text) return text;
    }
  }

  // Fallback: any body data
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }

  return '';
}

// ---------------------------------------------------------------------------
// BudgetTracker
// ---------------------------------------------------------------------------

function generateId(): string {
  return `bt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BudgetTracker {
  private auth: any;
  private sendMessage: (jid: string, text: string) => Promise<void>;
  private tokenPath: string;
  private extraSummaryJids: string[];

  constructor(
    sendMessage: (jid: string, text: string) => Promise<void>,
    extraSummaryJids: string[] = [],
  ) {
    this.sendMessage = sendMessage;
    this.extraSummaryJids = extraSummaryJids;
    this.tokenPath = DEFAULT_GOOGLE_TOKEN_PATH;

    const token = JSON.parse(fs.readFileSync(this.tokenPath, 'utf8'));
    const scopes: string = token.scope || '';
    if (!scopes.includes('gmail')) {
      throw new Error(
        'Google token is missing gmail scope. Re-run scripts/gcal-auth.mjs to re-authorize.',
      );
    }
    this.auth = createGoogleAuth(this.tokenPath);
  }

  start(): void {
    this.gmailPollLoop().catch((err) =>
      logger.error({ err }, 'Gmail poll loop crashed'),
    );
    this.replyPollLoop().catch((err) =>
      logger.error({ err }, 'Budget reply poll loop crashed'),
    );
    this.weeklySummaryLoop().catch((err) =>
      logger.error({ err }, 'Weekly summary loop crashed'),
    );
    logger.info('Budget tracker started');
  }

  // ── Gmail polling ──────────────────────────────────────────────────────────

  private async gmailPollLoop(): Promise<void> {
    while (true) {
      try {
        await this.pollGmail();
      } catch (err) {
        logger.error({ err }, 'Gmail poll error');
      }
      await sleep(GMAIL_POLL_MS);
    }
  }

  // Returns the number of new (previously unseen) transactions found.
  private async pollGmail(sinceOverride?: number): Promise<number> {
    const gmail = google.gmail({ version: 'v1', auth: this.auth });

    let sinceSecs: number;
    if (sinceOverride !== undefined) {
      sinceSecs = sinceOverride;
    } else {
      const lastChecked = getRouterState('gmail_budget_last_checked');
      if (lastChecked) {
        sinceSecs = parseInt(lastChecked, 10);
      } else {
        // First run: only look at emails from the last hour to avoid flooding
        sinceSecs = Math.floor((Date.now() - 3600_000) / 1000);
      }
    }

    const q = `from:${CARD_ALERT_SENDER} after:${sinceSecs}`;
    const res = await gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults: 20,
    });
    const messages = res.data.messages || [];

    // Only advance the cursor for scheduled polls (not manual on-demand ones)
    if (sinceOverride === undefined) {
      setRouterState(
        'gmail_budget_last_checked',
        Math.floor(Date.now() / 1000).toString(),
      );
    }

    let newCount = 0;
    for (const msg of messages) {
      try {
        const isNew = await this.processGmailMessage(gmail, msg.id!);
        if (isNew) newCount++;
      } catch (err) {
        logger.error({ err, msgId: msg.id }, 'Error processing Gmail message');
      }
    }

    if (messages.length > 0) {
      logger.info(
        { total: messages.length, newCount },
        'Processed card alert emails',
      );
    }
    return newCount;
  }

  // Manually triggered poll — used by the Discord "check transactions" command.
  // Falls back to 7 days if no new emails are found since last check.
  async pollNow(reply: (msg: string) => Promise<void>): Promise<void> {
    await reply('Checking Gmail for card alerts...');
    try {
      let found = await this.pollGmail();
      let ranFallback = false;

      if (found === 0) {
        // Widen to last 7 days so existing emails can be tested
        const sevenDaysAgo = Math.floor(
          (Date.now() - 7 * 24 * 3600_000) / 1000,
        );
        found = await this.pollGmail(sevenDaysAgo);
        ranFallback = true;
      }

      if (found === 0) {
        const window = ranFallback ? 'the last 7 days' : 'since last check';
        await reply(`No new card alert emails found (checked ${window}).`);
      } else {
        const window = ranFallback
          ? 'last 7 days (fallback)'
          : 'since last check';
        await reply(
          `Found ${found} new transaction${found === 1 ? '' : 's'} (${window}). Prompts sent above.`,
        );
      }
    } catch (err: any) {
      logger.error({ err }, 'pollNow error');
      await reply(`Error checking Gmail: ${err.message}`);
    }
  }

  private async processGmailMessage(
    gmail: any,
    msgId: string,
  ): Promise<boolean> {
    // Idempotency: skip if already processed
    if (getBudgetTransactionByEmailId(msgId)) return false;

    const full = await gmail.users.messages.get({
      userId: 'me',
      id: msgId,
      format: 'full',
    });

    const body = extractBodyText(full.data.payload);
    if (!body) return false;

    const tx = parseCardAlert(body);
    if (!tx) {
      logger.debug(
        { msgId, snippet: body.slice(0, 80) },
        'Email skipped (not a pending charge)',
      );
      return false;
    }

    const id = generateId();
    const shortId = getNextBudgetShortId();
    saveBudgetTransaction({
      id,
      email_id: msgId,
      short_id: shortId,
      date: tx.date,
      merchant: tx.merchant,
      amount: tx.amount,
      category: tx.category,
      status: 'pending',
      prompt_sent_at: null,
      created_at: new Date().toISOString(),
    });

    const jid = this.getMainGroupJid();
    if (!jid) {
      logger.warn(
        'Budget tracker: no main group JID found, cannot send notification',
      );
      return false;
    }

    const msg = [
      `New transaction detected [${shortId}]:`,
      `$${tx.amount.toFixed(2)} at ${tx.merchant}`,
      `Category: ${tx.category}`,
      `Date: ${tx.date}`,
      `Reply YES ${shortId} to log or NO ${shortId} to dismiss.`,
    ].join('\n');

    await this.sendMessage(jid, msg);
    setBudgetTransactionPromptSent(id, new Date().toISOString());

    logger.info(
      { merchant: tx.merchant, amount: tx.amount, category: tx.category },
      'Budget prompt sent',
    );
    return true;
  }

  // ── Reply detection ────────────────────────────────────────────────────────

  private async replyPollLoop(): Promise<void> {
    while (true) {
      try {
        await this.checkReplies();
      } catch (err) {
        logger.error({ err }, 'Budget reply check error');
      }
      await sleep(REPLY_POLL_MS);
    }
  }

  // Called directly from the message handler for immediate processing.
  // Returns a reply string to send, or null if the shortId isn't found.
  async handleReply(
    action: 'YES' | 'NO',
    shortId: string,
  ): Promise<string | null> {
    const tx = getBudgetTransactionByShortId(shortId);
    if (!tx) return null;

    if (action === 'YES') {
      await this.logToSheets(tx);
      updateBudgetTransactionStatus(tx.id, 'confirmed');
      logger.info(
        { shortId, merchant: tx.merchant, amount: tx.amount },
        'Transaction logged to Sheets',
      );
      return `✅ Logged $${tx.amount.toFixed(2)} at ${tx.merchant} to Google Sheets`;
    } else {
      updateBudgetTransactionStatus(tx.id, 'dismissed');
      logger.info({ shortId, merchant: tx.merchant }, 'Transaction dismissed');
      return `❌ Dismissed ${shortId} ($${tx.amount.toFixed(2)} at ${tx.merchant})`;
    }
  }

  // Log every pending transaction to Sheets in one shot.
  async handleLogAll(): Promise<string> {
    const pending = getAllPendingBudgetTransactions();
    if (pending.length === 0) return 'No pending transactions to log.';

    const lines: string[] = [];
    let logged = 0;
    for (const tx of pending) {
      try {
        await this.logToSheets(tx);
        updateBudgetTransactionStatus(tx.id, 'confirmed');
        lines.push(`✅ $${tx.amount.toFixed(2)} at ${tx.merchant}`);
        logged++;
        logger.info(
          { merchant: tx.merchant, amount: tx.amount },
          'Bulk-logged transaction',
        );
      } catch (err) {
        lines.push(`❌ Failed: $${tx.amount.toFixed(2)} at ${tx.merchant}`);
        logger.error({ err, txId: tx.id }, 'Bulk-log failed for transaction');
      }
    }
    return `Logged ${logged}/${pending.length} transactions to Google Sheets:\n${lines.join('\n')}`;
  }

  // Log the most recently created pending transaction.
  // Returns null if nothing is pending (caller should let message fall through).
  async handleLogMostRecent(): Promise<string | null> {
    const pending = getAllPendingBudgetTransactions();
    if (pending.length === 0) return null;

    const tx = pending[pending.length - 1];
    await this.logToSheets(tx);
    updateBudgetTransactionStatus(tx.id, 'confirmed');
    logger.info(
      { merchant: tx.merchant, amount: tx.amount },
      'Logged most-recent transaction',
    );
    return `✅ Logged $${tx.amount.toFixed(2)} at ${tx.merchant} to Google Sheets`;
  }

  // Log the first pending transaction whose merchant matches the search term.
  // Returns null if no match (caller should let message fall through).
  async handleLogByMerchant(term: string): Promise<string | null> {
    const tx = findPendingBudgetTransactionByMerchant(term);
    if (!tx) return null;

    await this.logToSheets(tx);
    updateBudgetTransactionStatus(tx.id, 'confirmed');
    logger.info(
      { merchant: tx.merchant, amount: tx.amount },
      'Logged transaction by merchant match',
    );
    return `✅ Logged $${tx.amount.toFixed(2)} at ${tx.merchant} to Google Sheets`;
  }

  private async checkReplies(): Promise<void> {
    const jid = this.getMainGroupJid();
    if (!jid) return;

    if (getPendingBudgetTransactions().length === 0) return;

    // Scan recent messages for "YES T1" / "NO T1" patterns
    const lastChecked = getRouterState('budget_reply_last_checked') || '';
    const msgs = getMessagesSince(jid, lastChecked, '');
    if (msgs.length === 0) return;

    // Advance cursor regardless of whether we matched anything
    const latestTs = msgs[msgs.length - 1].timestamp;
    setRouterState('budget_reply_last_checked', latestTs);

    for (const m of msgs) {
      // Strip Discord reply prefix then match pattern
      const text = m.content.trim().replace(/^\[Reply to [^\]]+\]\s*/i, '');
      const match = text.match(/^(YES|NO)\s+(T\d+)$/i);
      if (!match) continue;

      const action = match[1].toUpperCase() as 'YES' | 'NO';
      const shortId = match[2].toUpperCase();

      const tx = getBudgetTransactionByShortId(shortId);
      if (!tx) {
        logger.debug({ shortId }, 'No pending transaction found for short_id');
        continue;
      }

      if (action === 'YES') {
        await this.logToSheets(tx);
        updateBudgetTransactionStatus(tx.id, 'confirmed');
        logger.info(
          { shortId, merchant: tx.merchant, amount: tx.amount },
          'Transaction logged to Sheets',
        );
      } else {
        updateBudgetTransactionStatus(tx.id, 'dismissed');
        logger.info(
          { shortId, merchant: tx.merchant },
          'Transaction dismissed',
        );
      }
    }
  }

  private async logToSheets(tx: BudgetTransaction): Promise<void> {
    const sheets = google.sheets({ version: 'v4', auth: this.auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEETS_ID,
      range: SHEETS_RANGE,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[tx.date, tx.merchant, tx.amount, tx.category]],
      },
    });
  }

  // ── Weekly summary ─────────────────────────────────────────────────────────

  private async weeklySummaryLoop(): Promise<void> {
    while (true) {
      // Sleep until the next Sunday 8pm per TIMEZONE
      const next = CronExpressionParser.parse(WEEKLY_SUMMARY_CRON, {
        tz: TIMEZONE,
      }).next();
      const delay = next.getTime() - Date.now();
      logger.info(
        { next: next.toISOString(), delayMs: delay },
        'Budget weekly summary scheduled',
      );
      await sleep(delay);
      try {
        await this.sendWeeklySummary();
      } catch (err) {
        logger.error({ err }, 'Weekly summary error');
      }
    }
  }

  // Fetch this week's rows (Mon–Sun) from Google Sheets.
  private async fetchWeeklyFromSheets(): Promise<
    { date: string; merchant: string; amount: number; category: string }[]
  > {
    const sheets = google.sheets({ version: 'v4', auth: this.auth });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEETS_ID,
      range: SHEETS_RANGE,
    });

    const rows = response.data.values || [];

    // Compute Monday 00:00 and Sunday 23:59 of the current week
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0=Sun … 6=Sat
    const monday = new Date(now);
    monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
    monday.setHours(0, 0, 0, 0);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);

    const currentYear = now.getFullYear();
    const result: {
      date: string;
      merchant: string;
      amount: number;
      category: string;
    }[] = [];

    for (const row of rows) {
      if (!row[0] || !row[1] || !row[2]) continue;
      const [dateStr, merchant, amountStr, category] = row as string[];

      // Dates in the sheet are MM/DD
      const parts = String(dateStr).split('/');
      if (parts.length < 2) continue;
      const month = parseInt(parts[0], 10) - 1;
      const day = parseInt(parts[1], 10);
      if (isNaN(month) || isNaN(day)) continue;

      const txDate = new Date(currentYear, month, day);
      if (txDate < monday || txDate > sunday) continue;

      const amount = parseFloat(String(amountStr));
      if (isNaN(amount)) continue;

      result.push({
        date: String(dateStr),
        merchant: String(merchant),
        amount,
        category: String(category || 'Other'),
      });
    }

    return result;
  }

  private async sendWeeklySummary(): Promise<void> {
    const now = new Date();

    // Idempotency: don't send twice on the same day
    const todayStr = now.toISOString().slice(0, 10);
    const lastSent = getRouterState('budget_weekly_summary_date');
    if (lastSent === todayStr) return;

    const mainJid = this.getMainGroupJid();
    if (!mainJid) {
      logger.warn('Budget weekly summary: no main group JID found');
      return;
    }

    // Build Mon/Sun date strings for the header
    const dayOfWeek = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const fmtShort = (d: Date) =>
      d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    let message: string;

    try {
      const txns = await this.fetchWeeklyFromSheets();

      if (txns.length === 0) {
        message = `📊 Weekly Summary (${fmtShort(monday)} - ${fmtShort(sunday)})\nNo transactions logged this week.`;
      } else {
        const totals: Record<string, number> = {};
        for (const tx of txns) {
          totals[tx.category] = (totals[tx.category] || 0) + tx.amount;
        }
        const grandTotal = Object.values(totals).reduce((a, b) => a + b, 0);

        const categoryLines = Object.entries(totals)
          .sort((a, b) => b[1] - a[1])
          .map(([cat, amt]) => {
            const emoji = CATEGORY_EMOJI[cat] ?? '📦';
            return `${emoji} ${cat}: $${amt.toFixed(2)}`;
          });

        message = [
          `📊 Weekly Summary (${fmtShort(monday)} - ${fmtShort(sunday)})`,
          `Total: $${grandTotal.toFixed(2)} across ${txns.length} transaction${txns.length === 1 ? '' : 's'}`,
          '',
          ...categoryLines,
        ].join('\n');
      }
    } catch (err: any) {
      logger.error({ err }, 'Failed to fetch weekly data from Sheets');
      message = `📊 Weekly Summary: Could not fetch data from Google Sheets (${err.message})`;
    }

    // Send to main Discord group + any extra JIDs (e.g. SMS)
    const jids = [mainJid, ...this.extraSummaryJids];
    for (const jid of jids) {
      try {
        await this.sendMessage(jid, message);
      } catch (err) {
        logger.error({ err, jid }, 'Failed to send weekly summary');
      }
    }

    setRouterState('budget_weekly_summary_date', todayStr);
    logger.info(
      { jids, txnCount: message.includes('No transactions') ? 0 : undefined },
      'Weekly budget summary sent',
    );
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private getMainGroupJid(): string | null {
    const groups = getAllRegisteredGroups();
    const entry = Object.entries(groups).find(([, g]) => g.isMain === true);
    return entry ? entry[0] : null;
  }
}
