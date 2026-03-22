import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import { IncomingMessage, ServerResponse } from 'http';
import path from 'path';
import { promisify } from 'util';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const AUTH_STATES_DIR = path.join(
  process.cwd(),
  'groups',
  'discord_main',
  '.auth-states',
);
const BB_SESSION_FILE = path.join(process.cwd(), 'scripts', '.bb-session.json');
const LOGIN_SCRIPT = path.join(process.cwd(), 'scripts', 'bb-login.mjs');

// In-memory sessions: token → expiry ms
const SESSIONS = new Map<string, number>();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPin(): string {
  const env = readEnvFile(['BLACKBOARD_REFRESH_PIN']);
  return (
    process.env.BLACKBOARD_REFRESH_PIN ||
    env.BLACKBOARD_REFRESH_PIN ||
    '1234'
  ).trim();
}

function getPortalUrl(): string {
  const env = readEnvFile(['SMS_WEBHOOK_URL', 'PORTAL_URL']);
  return (
    process.env.PORTAL_URL ||
    env.PORTAL_URL ||
    process.env.SMS_WEBHOOK_URL ||
    env.SMS_WEBHOOK_URL ||
    'http://localhost:3002'
  ).replace(/\/$/, '');
}

function createSessionToken(): string {
  const token = crypto.randomBytes(20).toString('hex');
  SESSIONS.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function isValidSession(req: IncomingMessage): boolean {
  const header = req.headers.cookie ?? '';
  const cookies = Object.fromEntries(
    header.split(';').map((c) => {
      const eq = c.indexOf('=');
      return eq === -1
        ? [c.trim(), '']
        : [c.slice(0, eq).trim(), c.slice(eq + 1).trim()];
    }),
  );
  const token = cookies['bb_portal'];
  if (!token) return false;
  const expiry = SESSIONS.get(token);
  if (!expiry || Date.now() > expiry) {
    SESSIONS.delete(token);
    return false;
  }
  return true;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (chunk: Buffer) => (buf += chunk.toString()));
    req.on('end', () => resolve(buf));
  });
}

function jsonResponse(
  res: ServerResponse,
  statusCode: number,
  body: object,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function htmlResponse(res: ServerResponse, html: string): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

// ---------------------------------------------------------------------------
// HTML pages
// ---------------------------------------------------------------------------

const PIN_PAGE = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>Blackboard Portal</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  background:#0f0f1a;color:#fff;
  min-height:100dvh;
  display:flex;flex-direction:column;
  align-items:center;justify-content:center;
  padding:24px;
}
.icon{font-size:3rem;margin-bottom:12px}
h1{font-size:1.35rem;font-weight:600;color:#c0c0d8;margin-bottom:32px;letter-spacing:.02em}
.dots{display:flex;gap:18px;margin-bottom:44px}
.dot{
  width:20px;height:20px;border-radius:50%;
  background:#1e1e30;border:2px solid #3a3a58;
  transition:background .12s,border-color .12s;
}
.dot.filled{background:#4f7cff;border-color:#4f7cff}
.numpad{
  display:grid;grid-template-columns:repeat(3,1fr);
  gap:14px;width:288px;
}
.numpad button{
  height:72px;border-radius:18px;
  background:#1a1a2e;border:1.5px solid #2a2a42;
  color:#fff;font-size:1.7rem;font-weight:500;
  cursor:pointer;
  transition:background .1s,transform .08s;
  user-select:none;touch-action:manipulation;
}
.numpad button:active{background:#2c2c48;transform:scale(.94)}
.numpad .del{font-size:1.3rem;color:#8888aa}
.numpad .ghost{background:transparent!important;border:none!important;cursor:default}
.err{
  margin-top:22px;color:#ff5577;font-size:.92rem;
  height:22px;opacity:0;transition:opacity .2s;
}
.err.on{opacity:1}
@keyframes shake{
  0%,100%{transform:translateX(0)}
  20%,60%{transform:translateX(-9px)}
  40%,80%{transform:translateX(9px)}
}
.dots.shake{animation:shake .4s ease}
</style>
</head>
<body>
<div class="icon">🔒</div>
<h1>Blackboard Portal</h1>
<div class="dots" id="dots">
  <div class="dot" id="d0"></div>
  <div class="dot" id="d1"></div>
  <div class="dot" id="d2"></div>
  <div class="dot" id="d3"></div>
</div>
<div class="numpad">
  <button ontouchstart="" onclick="p('1')">1</button>
  <button ontouchstart="" onclick="p('2')">2</button>
  <button ontouchstart="" onclick="p('3')">3</button>
  <button ontouchstart="" onclick="p('4')">4</button>
  <button ontouchstart="" onclick="p('5')">5</button>
  <button ontouchstart="" onclick="p('6')">6</button>
  <button ontouchstart="" onclick="p('7')">7</button>
  <button ontouchstart="" onclick="p('8')">8</button>
  <button ontouchstart="" onclick="p('9')">9</button>
  <button class="ghost" disabled></button>
  <button ontouchstart="" onclick="p('0')">0</button>
  <button class="del" ontouchstart="" onclick="del()">⌫</button>
</div>
<div class="err" id="err">Incorrect PIN — try again</div>
<script>
let pin='';
function upd(){for(let i=0;i<4;i++)document.getElementById('d'+i).classList.toggle('filled',i<pin.length)}
function p(d){if(pin.length>=4)return;pin+=d;upd();if(pin.length===4)go()}
function del(){pin=pin.slice(0,-1);upd();document.getElementById('err').classList.remove('on')}
async function go(){
  const r=await fetch('/blackboard-verify-pin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin})});
  const d=await r.json();
  if(d.ok){window.location.href='/blackboard-login-page'}
  else{
    pin='';upd();
    const dots=document.getElementById('dots');
    dots.classList.add('shake');
    setTimeout(()=>dots.classList.remove('shake'),500);
    document.getElementById('err').classList.add('on');
  }
}
</script>
</body>
</html>`;

const LOGIN_PAGE = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>Blackboard Login</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  background:#0f0f1a;color:#fff;
  min-height:100dvh;
  display:flex;flex-direction:column;
  align-items:center;justify-content:center;
  padding:32px 24px;text-align:center;
}
.icon{font-size:3.5rem;margin-bottom:14px}
h1{font-size:1.55rem;font-weight:700;margin-bottom:12px}
.sub{
  color:#8a8aaa;font-size:1rem;line-height:1.55;
  max-width:320px;margin-bottom:40px;
}
.btn{
  display:block;width:100%;max-width:340px;
  padding:20px 24px;border-radius:18px;
  font-size:1.1rem;font-weight:600;border:none;
  cursor:pointer;
  transition:opacity .15s,transform .1s;
  margin-bottom:14px;user-select:none;
  touch-action:manipulation;
  -webkit-appearance:none;
}
.btn:active{transform:scale(.97);opacity:.85}
.btn:disabled{opacity:.45;cursor:default;transform:none}
.btn-open{background:#4f7cff;color:#fff}
.btn-grab{background:#27ae60;color:#fff;display:none}
.status{
  margin-top:24px;font-size:1rem;
  color:#8a8aaa;min-height:52px;
  line-height:1.5;max-width:320px;
}
.status.ok{color:#2ecc71;font-size:1.15rem;font-weight:600}
.status.err{color:#ff5577}
.spin{
  display:inline-block;
  width:18px;height:18px;
  border:2px solid #3a3a5a;
  border-top-color:#fff;
  border-radius:50%;
  animation:rot .75s linear infinite;
  vertical-align:middle;margin-right:8px;
}
@keyframes rot{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="icon">🎓</div>
<h1>Blackboard Login</h1>
<p class="sub">Tap the button below to log into Blackboard. Come back to this page after logging in.</p>

<button class="btn btn-open" id="openBtn" onclick="openBB()">Open Blackboard Login</button>
<button class="btn btn-grab" id="grabBtn" onclick="grab()">I've logged in — grab my session</button>

<div class="status" id="status"></div>

<script>
function openBB(){
  window.open('https://blackboard.sc.edu','_blank');
  document.getElementById('grabBtn').style.display='block';
  document.getElementById('status').textContent='Log in on Blackboard, then come back and tap the button above.';
}
async function grab(){
  const grabBtn=document.getElementById('grabBtn');
  const status=document.getElementById('status');
  grabBtn.disabled=true;
  status.className='status';
  status.innerHTML='<span class="spin"></span>Grabbing your session… (up to 60 seconds)';
  try{
    const r=await fetch('/blackboard-grab',{method:'POST'});
    const d=await r.json();
    if(d.ok){
      status.textContent='✅ Session refreshed! You can close this page.';
      status.className='status ok';
      grabBtn.style.display='none';
      document.getElementById('openBtn').style.display='none';
    }else{
      status.textContent='❌ '+(d.error||'Login failed — try again');
      status.className='status err';
      grabBtn.disabled=false;
    }
  }catch(e){
    status.textContent='❌ Network error — try again';
    status.className='status err';
    grabBtn.disabled=false;
  }
}
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// BlackboardPortal
// ---------------------------------------------------------------------------

type NotifyFn = (jids: string[], message: string) => Promise<void>;

export class BlackboardPortal {
  private notify: NotifyFn | null = null;

  setNotifyCallback(fn: NotifyFn): void {
    this.notify = fn;
  }

  /**
   * Called from SmsChannel's request handler.
   * Returns true if this request was handled (caller should not continue).
   */
  handleRequest(req: IncomingMessage, res: ServerResponse): boolean {
    const method = req.method?.toUpperCase() ?? '';
    const urlPath = (req.url ?? '/').split('?')[0];

    if (method === 'GET' && urlPath === '/blackboard-login') {
      htmlResponse(res, PIN_PAGE);
      return true;
    }

    if (method === 'POST' && urlPath === '/blackboard-verify-pin') {
      this.verifyPin(req, res).catch((err) => this.internalError(res, err));
      return true;
    }

    if (method === 'GET' && urlPath === '/blackboard-login-page') {
      if (!isValidSession(req)) {
        res.writeHead(302, { Location: '/blackboard-login' });
        res.end();
        return true;
      }
      htmlResponse(res, LOGIN_PAGE);
      return true;
    }

    if (method === 'POST' && urlPath === '/blackboard-grab') {
      if (!isValidSession(req)) {
        jsonResponse(res, 401, { ok: false, error: 'Not authenticated' });
        return true;
      }
      this.grabSession(req, res).catch((err) => this.internalError(res, err));
      return true;
    }

    if (method === 'POST' && urlPath === '/blackboard-callback') {
      this.cookieCallback(req, res).catch((err) =>
        this.internalError(res, err),
      );
      return true;
    }

    if (method === 'POST' && urlPath === '/bb-expired') {
      this.handleExpired(req, res).catch((err) => this.internalError(res, err));
      return true;
    }

    return false;
  }

  private internalError(res: ServerResponse, err: unknown): void {
    logger.error({ err }, 'BlackboardPortal route error');
    if (!res.headersSent) {
      res.writeHead(500);
      res.end('Internal Server Error');
    }
  }

  // POST /blackboard-verify-pin — { pin: "1234" }
  private async verifyPin(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await readBody(req);
    let pin = '';
    try {
      pin = JSON.parse(body).pin ?? '';
    } catch {
      jsonResponse(res, 400, { ok: false, error: 'Invalid JSON' });
      return;
    }

    if (pin !== getPin()) {
      logger.info('Blackboard portal: incorrect PIN attempt');
      jsonResponse(res, 200, { ok: false });
      return;
    }

    const token = createSessionToken();
    logger.info('Blackboard portal: PIN verified, session created');
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': `bb_portal=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=1800`,
    });
    res.end(JSON.stringify({ ok: true }));
  }

  // POST /blackboard-grab — trigger bb-login.mjs server-side
  private async grabSession(
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const startedAt = Date.now();
    logger.info(
      { script: LOGIN_SCRIPT },
      'Blackboard portal: /blackboard-grab triggered — spawning bb-login.mjs --discord',
    );

    let stdout = '';
    let stderr = '';
    try {
      ({ stdout, stderr } = await execFileAsync(
        'node',
        [LOGIN_SCRIPT, '--discord'],
        {
          timeout: 180_000, // 3 minutes
          cwd: process.cwd(),
          env: { ...process.env },
        },
      ));

      const durationMs = Date.now() - startedAt;
      logger.info(
        { durationMs, stdout, stderr: stderr || '(none)' },
        'bb-login.mjs exited successfully',
      );

      // Copy session to .auth-states/blackboard.json
      if (fs.existsSync(BB_SESSION_FILE)) {
        const session = JSON.parse(fs.readFileSync(BB_SESSION_FILE, 'utf8'));
        fs.mkdirSync(AUTH_STATES_DIR, { recursive: true });
        fs.writeFileSync(
          path.join(AUTH_STATES_DIR, 'blackboard.json'),
          JSON.stringify(session, null, 2),
          { mode: 0o600 },
        );
        logger.info(
          { savedAt: session.saved_at },
          'Blackboard session copied to .auth-states/blackboard.json',
        );
      } else {
        logger.warn(
          { path: BB_SESSION_FILE },
          'bb-login.mjs succeeded but session file not found — session may not have been saved',
        );
      }

      // Notify Discord + SMS that the session was refreshed
      if (this.notify) {
        const msg =
          '✅ Blackboard session refreshed via mobile portal. Good for another 24-48 hours.';
        this.notify(['discord_main', 'sms:+18642756439'], msg).catch((err) =>
          logger.error({ err }, 'Portal: failed to send refresh notification'),
        );
      }

      jsonResponse(res, 200, { ok: true });
    } catch (err: any) {
      const durationMs = Date.now() - startedAt;
      // execFileAsync puts script output in err.stdout / err.stderr on non-zero exit
      const scriptStdout = err.stdout ?? stdout;
      const scriptStderr = err.stderr ?? stderr;
      logger.error(
        {
          durationMs,
          exitCode: err.code,
          signal: err.signal,
          stdout: scriptStdout || '(none)',
          stderr: scriptStderr || '(none)',
          message: err.message,
        },
        'bb-login.mjs failed',
      );
      jsonResponse(res, 200, {
        ok: false,
        error: err.message ?? 'Login failed',
      });
    }
  }

  // POST /blackboard-callback — accept cookie data and save to auth-states
  private async cookieCallback(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await readBody(req);
    let cookies: string;

    const ct = req.headers['content-type'] ?? '';
    if (ct.includes('application/json')) {
      try {
        const parsed = JSON.parse(body);
        // Accept { cookies: "..." } or { cookies: [...] }
        if (typeof parsed.cookies === 'string') {
          cookies = parsed.cookies;
        } else if (Array.isArray(parsed.cookies)) {
          // Cookie-Editor format: [{ name, value, ... }]
          cookies = parsed.cookies
            .map((c: any) => `${c.name}=${c.value}`)
            .join('; ');
        } else {
          jsonResponse(res, 400, {
            ok: false,
            error: 'cookies field required',
          });
          return;
        }
      } catch {
        jsonResponse(res, 400, { ok: false, error: 'Invalid JSON' });
        return;
      }
    } else {
      // Plain text: raw cookie string
      cookies = body.trim();
    }

    if (!cookies) {
      jsonResponse(res, 400, { ok: false, error: 'Empty cookies' });
      return;
    }

    const session = {
      cookies,
      saved_at: new Date().toISOString(),
      source: 'portal',
    };

    fs.mkdirSync(AUTH_STATES_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(AUTH_STATES_DIR, 'blackboard.json'),
      JSON.stringify(session, null, 2),
      { mode: 0o600 },
    );

    // Also update .bb-session.json so update_calendar.py picks it up
    fs.writeFileSync(BB_SESSION_FILE, JSON.stringify(session, null, 2), {
      mode: 0o600,
    });

    logger.info('Blackboard cookies saved via /blackboard-callback');
    jsonResponse(res, 200, { ok: true });
  }

  // POST /bb-expired — called by update_calendar.py when session is unrecoverable
  private async handleExpired(
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    logger.warn('Blackboard portal: session expired notification received');
    jsonResponse(res, 200, { ok: true });

    if (!this.notify) return;

    const portalUrl = getPortalUrl();
    const message = `⚠️ Blackboard session expired. Tap here to refresh:\n${portalUrl}/blackboard-login`;

    try {
      await this.notify(
        [
          'discord_main', // resolved to real JID by callback in index.ts
          'sms:+18642756439',
        ],
        message,
      );
    } catch (err) {
      logger.error({ err }, 'Failed to send BB expiry notification');
    }
  }
}
