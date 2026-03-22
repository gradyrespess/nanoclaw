#!/usr/bin/env python3
"""
Blackboard → Google Calendar sync
Uses a Playwright-based CAS login (scripts/bb-login.mjs) for authentication.
Session cookies are cached in scripts/.bb-session.json for up to 2.5 hours.

Run: python3 update_calendar.py
     python3 update_calendar.py --discord   # Duo via Discord instead of stdin
"""

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).parent

# When running inside the NanoClaw container, /workspace/group is writable.
_container_dir = Path('/workspace/group')
TOKEN_DIR = _container_dir if _container_dir.exists() else SCRIPT_DIR / 'scripts'

GCAL_TOKEN_FILE  = TOKEN_DIR / '.gcal-token.json'
BB_SESSION_FILE  = SCRIPT_DIR / 'scripts' / '.bb-session.json'
LOGIN_SCRIPT     = SCRIPT_DIR / 'scripts' / 'bb-login.mjs'

BB_HOST       = 'https://blackboard.sc.edu'
BB_USER_AGENT = 'Mozilla/5.0 (compatible; NanoClaw/1.0)'

def _read_env():
    """Read key=value pairs from the .env file next to this script."""
    env = {}
    env_file = SCRIPT_DIR / '.env'
    try:
        for line in env_file.read_text().splitlines():
            if '=' in line and not line.strip().startswith('#'):
                k, _, v = line.partition('=')
                env[k.strip()] = v.strip()
    except Exception:
        pass
    return env

_env = _read_env()

def _notify_bb_expired():
    """POST to NanoClaw server so it can send expiry notifications to Discord + SMS."""
    url = (os.environ.get('NANOCLAW_NOTIFY_URL') or
           _env.get('SMS_WEBHOOK_URL') or
           _env.get('NANOCLAW_NOTIFY_URL') or '')
    if not url:
        return
    try:
        notify_url = url.rstrip('/') + '/bb-expired'
        req = urllib.request.Request(notify_url, data=b'{}', method='POST')
        req.add_header('Content-Type', 'application/json')
        with urllib.request.urlopen(req, timeout=5) as r:
            print(f'  📨 Expiry notification sent ({r.status})')
    except Exception as e:
        print(f'  ⚠️  Could not send expiry notification: {e}')

OAUTH_CLIENT_ID     = os.environ.get('GOOGLE_CLIENT_ID', _env.get('GOOGLE_CLIENT_ID', ''))
OAUTH_CLIENT_SECRET = os.environ.get('GOOGLE_CLIENT_SECRET', _env.get('GOOGLE_CLIENT_SECRET', ''))
OAUTH_REDIRECT_URI  = 'http://localhost:3456'

SEMESTER_FILTER   = 'SPRING-2026'
SESSION_MAX_AGE_S = 2.5 * 3600   # 2.5 hours

USE_DISCORD = '--discord' in sys.argv

# ── Blackboard session management ─────────────────────────────────────────────

def load_session():
    """Return cookie string if saved session is still fresh, else None."""
    if not BB_SESSION_FILE.exists():
        return None
    try:
        session = json.loads(BB_SESSION_FILE.read_text())
        saved_at = datetime.fromisoformat(session['saved_at'].replace('Z', '+00:00'))
        age_s = (datetime.now(timezone.utc) - saved_at).total_seconds()
        if age_s > SESSION_MAX_AGE_S:
            print(f'  ⏰ Session expired ({age_s/60:.0f} min old) — re-login needed')
            return None
        return session['cookies']
    except Exception:
        return None

def run_login():
    """Run bb-login.mjs to refresh the Blackboard session."""
    print('🔐 Running Blackboard CAS login...')
    args = ['node', str(LOGIN_SCRIPT)]
    if USE_DISCORD:
        args.append('--discord')
    subprocess.run(args, check=True, cwd=SCRIPT_DIR.parent)

def ensure_session():
    """Return fresh cookie string, triggering login if needed."""
    cookies = load_session()
    if not cookies:
        run_login()
        cookies = load_session()
        if not cookies:
            print('❌ Login completed but session file not found')
            sys.exit(1)
    return cookies

# ── Blackboard REST API ───────────────────────────────────────────────────────

def bb_get(path, bb_cookies, retried=False):
    url = f'{BB_HOST}{path}'
    req = urllib.request.Request(url)
    req.add_header('Cookie', bb_cookies)
    req.add_header('User-Agent', BB_USER_AGENT)
    req.add_header('Accept', 'application/json')
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read()), bb_cookies
    except urllib.error.HTTPError as e:
        if e.code in (401, 403) and not retried:
            print('  🔄 Session rejected — refreshing via browser login...')
            BB_SESSION_FILE.unlink(missing_ok=True)
            run_login()
            new_cookies = load_session()
            if not new_cookies:
                _notify_bb_expired()
                raise RuntimeError('Re-login failed')
            return bb_get(path, new_cookies, retried=True)
        if e.code in (401, 403):
            # Second consecutive 401/403 — session is unrecoverable
            _notify_bb_expired()
        raise

def get_courses(bb_cookies):
    print('📚 Fetching your courses...')
    data, bb_cookies = bb_get(
        '/learn/api/public/v1/users/me/courses?limit=100&fields=courseId,course.courseId,course.name',
        bb_cookies,
    )
    courses = [
        {'id': m['courseId'], 'name': m['course']['name'], 'courseId': m['course']['courseId']}
        for m in data.get('results', [])
        if SEMESTER_FILTER in m.get('course', {}).get('courseId', '')
    ]
    print(f'  Found {len(courses)} {SEMESTER_FILTER} courses')
    return courses, bb_cookies

def get_assignments(course, bb_cookies):
    print(f'  📋 {course["name"]}')
    assignments = []
    try:
        data, bb_cookies = bb_get(
            f'/learn/api/public/v1/courses/{course["id"]}/gradebook/columns?limit=100',
            bb_cookies,
        )
        for col in data.get('results', []):
            if col.get('grading', {}).get('type') == 'Calculated':
                continue
            due_raw = col.get('grading', {}).get('due')
            due_date = due_raw[:10] if due_raw else None
            assignments.append({
                'name':   col.get('name', 'Untitled'),
                'due':    due_date,
                'points': col.get('score', {}).get('possible'),
                'course': course['name'],
            })
    except Exception as e:
        print(f'     ⚠️  Could not fetch gradebook: {e}')
    print(f'     → {len(assignments)} item(s) found')
    return assignments, bb_cookies

# ── Google OAuth ──────────────────────────────────────────────────────────────

def load_gcal_token():
    if GCAL_TOKEN_FILE.exists():
        return json.loads(GCAL_TOKEN_FILE.read_text())
    return None

def save_gcal_token(token):
    GCAL_TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    GCAL_TOKEN_FILE.write_text(json.dumps(token))

def refresh_gcal_token(token):
    data = urllib.parse.urlencode({
        'client_id':     OAUTH_CLIENT_ID,
        'client_secret': OAUTH_CLIENT_SECRET,
        'refresh_token': token['refresh_token'],
        'grant_type':    'refresh_token',
    }).encode()
    req = urllib.request.Request('https://oauth2.googleapis.com/token', data=data, method='POST')
    with urllib.request.urlopen(req) as r:
        new = json.loads(r.read())
    token.update(new)
    save_gcal_token(token)
    return token

def get_auth_token():
    token = load_gcal_token()
    if token:
        expiry_ms = token.get('expiry_date', 0)
        if expiry_ms and expiry_ms < (datetime.now().timestamp() * 1000 + 60_000):
            print('Refreshing Google token...')
            token = refresh_gcal_token(token)
        return token['access_token']

    import http.server
    import webbrowser

    params = urllib.parse.urlencode({
        'client_id':     OAUTH_CLIENT_ID,
        'redirect_uri':  OAUTH_REDIRECT_URI,
        'response_type': 'code',
        'scope':         'https://www.googleapis.com/auth/calendar',
        'access_type':   'offline',
    })
    auth_url = f'https://accounts.google.com/o/oauth2/v2/auth?{params}'
    print(f'\nOpen this URL to authorize Google Calendar:\n\n{auth_url}\n')
    webbrowser.open(auth_url)

    code_holder = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query)
            if 'code' in qs:
                code_holder['code'] = qs['code'][0]
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'<h2>Authorized! You can close this tab.</h2>')
        def log_message(self, *_): pass

    server = http.server.HTTPServer(('localhost', 3456), Handler)
    print('Waiting for authorization...')
    while 'code' not in code_holder:
        server.handle_request()
    server.server_close()

    data = urllib.parse.urlencode({
        'code':          code_holder['code'],
        'client_id':     OAUTH_CLIENT_ID,
        'client_secret': OAUTH_CLIENT_SECRET,
        'redirect_uri':  OAUTH_REDIRECT_URI,
        'grant_type':    'authorization_code',
    }).encode()
    req = urllib.request.Request('https://oauth2.googleapis.com/token', data=data, method='POST')
    with urllib.request.urlopen(req) as r:
        token = json.loads(r.read())
    save_gcal_token(token)
    return token['access_token']

# ── Google Calendar API ───────────────────────────────────────────────────────

def gcal_request(method, path, access_token, body=None):
    url = f'https://www.googleapis.com/calendar/v3{path}'
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Authorization', f'Bearer {access_token}')
    req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

def get_primary_calendar(access_token):
    result = gcal_request('GET', '/users/me/calendarList', access_token)
    for cal in result.get('items', []):
        if cal.get('primary'):
            return cal['id']
    return 'primary'

def add_event(calendar_id, access_token, title, date_str, description):
    event = {
        'summary':     title,
        'description': description,
        'start':       {'date': date_str},
        'end':         {'date': date_str},
        'reminders':   {'useDefault': False, 'overrides': []},
    }
    return gcal_request('POST', f'/calendars/{urllib.parse.quote(calendar_id)}/events',
                         access_token, body=event)

def fetch_existing_event_keys(calendar_id, access_token):
    import re
    keys = set()
    page_token = None
    params_base = {
        'timeMin':      '2026-01-01T00:00:00-05:00',
        'timeMax':      '2026-06-01T00:00:00-04:00',
        'maxResults':   '2500',
        'singleEvents': 'true',
    }
    while True:
        params = dict(params_base)
        if page_token:
            params['pageToken'] = page_token
        qs = urllib.parse.urlencode(params)
        result = gcal_request('GET', f'/calendars/{urllib.parse.quote(calendar_id)}/events?{qs}', access_token)
        for ev in result.get('items', []):
            desc = ev.get('description', '') or ''
            if 'Course:' not in desc:
                continue
            title_norm = re.sub(r'\s*\(\d+(?:\.\d+)?\s*pts\)\s*$', '', ev.get('summary', '')).strip().lower()
            start = ev.get('start', {})
            date = (start.get('dateTime') or start.get('date') or '')[:10]
            keys.add(f'{title_norm}|{date}')
        page_token = result.get('nextPageToken')
        if not page_token:
            break
    return keys

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print('🎓 Blackboard → Google Calendar Sync\n')

    # Blackboard session (browser-based CAS login)
    bb_cookies = ensure_session()
    print('✅ Blackboard session ready\n')

    # Google Calendar auth
    access_token = get_auth_token()
    print('✅ Google authorized\n')

    # Courses
    try:
        courses, bb_cookies = get_courses(bb_cookies)
    except Exception as e:
        print(f'❌ Could not fetch courses: {e}')
        sys.exit(1)

    if not courses:
        print(f'❌ No {SEMESTER_FILTER} courses found.')
        sys.exit(1)

    # Assignments
    print('\n📖 Fetching assignments per course...')
    all_assignments = []
    for course in courses:
        assignments, bb_cookies = get_assignments(course, bb_cookies)
        all_assignments.extend(assignments)

    print(f'\n📊 Total items found: {len(all_assignments)}')

    # Calendar
    calendar_id = get_primary_calendar(access_token)
    print(f'\n📅 Syncing to calendar: {calendar_id}')

    print('  Checking existing events for duplicates...')
    existing_keys = fetch_existing_event_keys(calendar_id, access_token)
    print(f'  Found {len(existing_keys)} existing NanoClaw events.\n')

    added = skipped = duplicates = errors = 0
    for a in all_assignments:
        if not a['due']:
            print(f'  ⚠️  No date: "{a["name"]}" — skipping')
            skipped += 1
            continue

        # Skip placeholder dates far in the future (e.g. Blackboard default 2029-01-01)
        due_year = int(a['due'][:4])
        if due_year > datetime.now().year + 2:
            print(f'  ⚠️  Skipping far-future placeholder date: "{a["name"]}" on {a["due"]}')
            skipped += 1
            continue

        title = a['name']
        if a['points'] is not None:
            title += f' ({a["points"]:.0f} pts)'

        title_norm = a['name'].strip().lower()
        dedupe_key = f'{title_norm}|{a["due"]}'

        if dedupe_key in existing_keys:
            print(f'  ⏭  Already exists: "{title}" on {a["due"]}')
            duplicates += 1
            continue

        desc = f'Course: {a["course"]}\nSource: gradebook\nAdded by: NanoClaw'
        try:
            add_event(calendar_id, access_token, title, a['due'], desc)
            existing_keys.add(dedupe_key)
            print(f'  ✅ {a["course"]}: "{title}" → {a["due"]}')
            added += 1
        except Exception as e:
            print(f'  ❌ Failed "{title}": {e}')
            errors += 1

    print(f'\n🎉 Done! {added} added, {duplicates} already existed (skipped), {skipped} had no date, {errors} errors.')

if __name__ == '__main__':
    main()
