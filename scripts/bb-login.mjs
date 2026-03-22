#!/usr/bin/env node
/**
 * Blackboard CAS login via Playwright.
 * Authenticates through USC's CAS SSO, handles Duo 2FA via Discord,
 * and saves session cookies to scripts/.bb-session.json for use by sync scripts.
 *
 * Usage:
 *   node scripts/bb-login.mjs               # prompt Duo code via stdin
 *   node scripts/bb-login.mjs --discord      # send Duo screenshot to Discord, wait for reply
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

// Ensure Chromium's shared libraries are on the path (WSL2: no system nspr/nss).
// The libs are extracted from Ubuntu debs into /tmp/chromium-libs on first run.
function ensureChromiumLibs() {
  const libDir = '/tmp/chromium-libs/usr/lib/x86_64-linux-gnu';
  if (fs.existsSync(path.join(libDir, 'libnspr4.so'))) return libDir;

  console.log('  📦 Installing Chromium system libraries (one-time setup)...');
  const tmpDir = '/tmp/chromium-libs';
  fs.mkdirSync(tmpDir, { recursive: true });

  const mirror = 'http://archive.ubuntu.com/ubuntu/pool/main';
  const debs = [
    'n/nspr/libnspr4_4.35-1.1build1_amd64.deb',
    'n/nss/libnss3_3.98-1build1_amd64.deb',
    'a/alsa-lib/libasound2t64_1.2.11-1build2_amd64.deb',
  ];
  for (const pkg of debs) {
    const fname = path.basename(pkg);
    const dest = path.join(tmpDir, fname);
    execFileSync('curl', ['-sL', `${mirror}/${pkg}`, '-o', dest]);
    execFileSync('dpkg-deb', ['--extract', dest, tmpDir]);
  }
  console.log('  ✅ Libraries ready.');
  return libDir;
}

const libDir = ensureChromiumLibs();
process.env.LD_LIBRARY_PATH = [libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BB_CREDS_FILE   = path.join(__dirname, '.bb-creds.json');
const BB_SESSION_FILE = path.join(__dirname, '.bb-session.json');
const ENV_FILE        = path.join(__dirname, '..', '.env');

const BB_HOST       = 'https://blackboard.sc.edu';
const CAS_LOGIN_URL = `${BB_HOST}/webapps/bb-auth-provider-cas-BB5dd6acf5e22a7/execute/casLogin?cmd=login&authProviderId=_132_1&redirectUrl=${encodeURIComponent(BB_HOST + '/ultra')}`;

const USE_DISCORD    = process.argv.includes('--discord');
// Discord channel to send Duo screenshot to (gradybot #general)
const DISCORD_CHANNEL_ID = '1484008410729943093';
const DUO_WAIT_MS        = 30_000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function readEnv() {
  try {
    const raw = fs.readFileSync(ENV_FILE, 'utf8');
    const env = {};
    for (const line of raw.split('\n')) {
      const [k, ...v] = line.split('=');
      if (k && v.length) env[k.trim()] = v.join('=').trim();
    }
    return env;
  } catch {
    return {};
  }
}

function loadCreds() {
  if (!fs.existsSync(BB_CREDS_FILE)) {
    throw new Error(`Credentials not found at ${BB_CREDS_FILE}. Run the sync script first to set them up.`);
  }
  return JSON.parse(fs.readFileSync(BB_CREDS_FILE, 'utf8'));
}

function saveSession(cookieString, username) {
  const session = {
    cookies:  cookieString,
    saved_at: new Date().toISOString(),
    username,
  };
  fs.writeFileSync(BB_SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
  console.log(`✅ Session saved to ${BB_SESSION_FILE}`);
}

// ── Duo via Discord ───────────────────────────────────────────────────────────

/**
 * Send a screenshot to Discord, then poll for the user's reply.
 * Uses the Discord REST API directly to avoid a second websocket client.
 * Returns the Duo code string, or null on timeout.
 */
async function askDuoViaDiscord(screenshotPath, discordToken) {
  const API = 'https://discord.com/api/v10';
  const headers = {
    'Authorization': `Bot ${discordToken}`,
    'User-Agent': 'NanoClaw/1.0',
  };

  // Get the most recent message ID so we only watch for NEW replies
  const historyRes = await fetch(`${API}/channels/${DISCORD_CHANNEL_ID}/messages?limit=1`, { headers });
  const history = await historyRes.json();
  const lastId = history[0]?.id ?? '0';

  // Send the screenshot as an image attachment
  const form = new FormData();
  form.append('content', '📱 **Duo 2FA needed for Blackboard sync.**\nWhat is the passcode showing in your Duo app? Reply with just the 6-digit code.');
  const imageBlob = new Blob([fs.readFileSync(screenshotPath)], { type: 'image/png' });
  form.append('files[0]', imageBlob, 'duo-prompt.png');

  const sendRes = await fetch(`${API}/channels/${DISCORD_CHANNEL_ID}/messages`, {
    method: 'POST',
    headers,   // Note: don't set Content-Type — fetch sets multipart boundary automatically
    body: form,
  });

  if (!sendRes.ok) {
    const err = await sendRes.text();
    throw new Error(`Discord send failed: ${sendRes.status} ${err}`);
  }
  console.log('  📨 Screenshot sent to Discord. Waiting for Duo code reply...');

  // Poll for a reply containing a 6-digit code
  const deadline = Date.now() + DUO_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const pollRes = await fetch(
      `${API}/channels/${DISCORD_CHANNEL_ID}/messages?after=${lastId}&limit=10`,
      { headers },
    );
    const msgs = await pollRes.json();
    for (const msg of msgs) {
      if (msg.author?.bot) continue;
      const match = msg.content?.trim().match(/^(\d{6,8})$/);
      if (match) {
        console.log(`  ✅ Got Duo code from Discord.`);
        return match[1];
      }
    }
  }
  return null;
}

// ── Duo via stdin ─────────────────────────────────────────────────────────────

async function askDuoViaStdin(screenshotPath) {
  console.log(`\n📸 Duo screenshot saved to: ${screenshotPath}`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question('Enter Duo passcode: ', code => {
      rl.close();
      resolve(code.trim());
    });
  });
}

// ── Main login flow ───────────────────────────────────────────────────────────

async function login() {
  const creds = loadCreds();
  const env   = readEnv();
  const discordToken = process.env.DISCORD_BOT_TOKEN || env.DISCORD_BOT_TOKEN;

  if (USE_DISCORD && !discordToken) {
    throw new Error('--discord flag set but DISCORD_BOT_TOKEN not found in .env');
  }

  console.log(`🌐 Launching browser for CAS login (${creds.username})...`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  try {
    // Navigate to Blackboard CAS login
    await page.goto(CAS_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Should now be on the CAS login page at cas.auth.sc.edu
    console.log(`  → ${page.url()}`);

    // Fill credentials on CAS login form
    await page.waitForSelector('input[name="username"], #username', { timeout: 15_000 });
    await page.fill('input[name="username"], #username', creds.username);
    await page.fill('input[name="password"], #password', creds.password);
    await page.click('input[type="submit"], button[type="submit"], .btn-submit', { timeout: 10_000 });

    console.log('  ✏️  Credentials submitted, waiting for redirect...');

    // Wait for either Blackboard, Duo, or an error
    await page.waitForURL(url => {
      const u = url.toString();
      return u.includes('blackboard.sc.edu') || u.includes('duosecurity.com') || u.includes('duo.sc.edu');
    }, { timeout: 30_000 }).catch(() => {});

    const currentUrl = page.url();
    console.log(`  → ${currentUrl}`);

    // ── Duo 2FA ────────────────────────────────────────────────────────────
    const isDuo = currentUrl.includes('duo') ||
      await page.$('iframe[src*="duo"]').then(el => !!el).catch(() => false) ||
      await page.$('#duo_iframe, #duo-frame').then(el => !!el).catch(() => false);

    if (isDuo) {
      console.log('  🔐 Duo 2FA detected...');
      const screenshotPath = path.join(__dirname, 'duo-prompt.png');
      await page.screenshot({ path: screenshotPath, fullPage: false });

      let code;
      if (USE_DISCORD && discordToken) {
        code = await askDuoViaDiscord(screenshotPath, discordToken);
      } else {
        code = await askDuoViaStdin(screenshotPath);
      }

      if (!code) {
        throw new Error('Duo code not received within timeout');
      }

      // Handle Duo Universal Prompt (duosecurity.com iframe or embedded)
      const duoFrame = page.frames().find(f => f.url().includes('duo')) || page;

      // Try to select "Passcode" option and enter code
      try {
        // Duo Universal Prompt: "Other options" → "Passcode"
        const otherOptions = await duoFrame.$('button[data-testid="button-useOtherMethod"], button:has-text("Other options"), #other-options-link');
        if (otherOptions) {
          await otherOptions.click();
          await page.waitForTimeout(1000);
        }
        const passcodeBtn = await duoFrame.$('button:has-text("Passcode"), #passcode-option, [data-testid="button-usePasscode"]');
        if (passcodeBtn) await passcodeBtn.click();
        await page.waitForTimeout(500);

        // Enter the code
        const codeInput = await duoFrame.$('input[name="passcode"], input[id*="passcode"], #duo-passcode-input');
        if (codeInput) {
          await codeInput.fill(code);
        } else {
          // Fallback: type code into whatever is focused
          await page.keyboard.type(code);
        }

        // Submit
        const submitBtn = await duoFrame.$('button[type="submit"]:has-text("Log In"), button:has-text("Verify"), #passcode-submit, [data-testid="button-submit"]');
        if (submitBtn) {
          await submitBtn.click();
        } else {
          await page.keyboard.press('Enter');
        }
      } catch (e) {
        console.warn(`  ⚠️  Duo UI navigation issue: ${e.message} — trying keyboard entry`);
        await page.keyboard.type(code);
        await page.keyboard.press('Enter');
      }

      console.log('  ⏳ Duo code submitted, waiting for Blackboard...');
      await page.waitForURL(url => url.toString().includes('blackboard.sc.edu'), { timeout: 30_000 });
      console.log('  → ' + page.url());
    }

    // ── Verify we're logged in ─────────────────────────────────────────────
    if (!page.url().includes('blackboard.sc.edu')) {
      await page.screenshot({ path: path.join(__dirname, 'login-failed.png') });
      throw new Error(`Login failed — ended up at: ${page.url()}`);
    }

    // Wait a moment for all cookies to be set
    await page.waitForTimeout(2000);

    // ── Extract cookies ────────────────────────────────────────────────────
    const cookies = await context.cookies('https://blackboard.sc.edu');
    const cookieMap = Object.fromEntries(cookies.map(c => [c.name, c.value]));

    if (!cookieMap.BbRouter) {
      throw new Error('Login appeared successful but BbRouter cookie not found');
    }

    const parts = [`BbRouter=${cookieMap.BbRouter}`];
    if (cookieMap.AWSELB)     parts.push(`AWSELB=${cookieMap.AWSELB}`);
    if (cookieMap.AWSELBCORS) parts.push(`AWSELBCORS=${cookieMap.AWSELBCORS}`);
    if (cookieMap.JSESSIONID) parts.push(`JSESSIONID=${cookieMap.JSESSIONID}`);
    parts.push('BbClientCalenderTimeZone=America/New_York');

    const cookieString = parts.join('; ');
    saveSession(cookieString, creds.username);
    console.log('\n🎉 Login successful!');

  } finally {
    await browser.close();
  }
}

login().catch(err => {
  console.error(`\n❌ Login failed: ${err.message}`);
  process.exit(1);
});
