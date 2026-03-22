---
name: playwright
description: Autonomous browser control with credential management, session reuse, retry logic, and structured data extraction. Use for logging into websites, form automation, scraping, screenshots, and any task requiring a real browser with stored credentials.
allowed-tools: Bash(pw:*), Bash(agent-browser:*)
---

# Playwright (`pw` + `agent-browser`)

`pw` — credentials, auto-login, session reuse, bulk extraction
`agent-browser` — interactive step-by-step control (click, fill, snapshot)

## Credentials

Stored in `/workspace/group/credentials.json` (0600).

```bash
pw creds set <site> <user> <pass> [loginUrl]   # store
pw creds list                                   # show sites (no passwords)
pw creds delete <site>
```

## Login & session management

```bash
pw login <site> [loginUrl]   # auto-login + save session; exits code 2 if MFA needed
pw auth list                 # show saved sessions
pw auth clear <site>         # force re-login next time
```

Handles automatically: standard form, multi-step (email→Next→password), Microsoft (`login.microsoftonline.com`), Google (`accounts.google.com`), SSO redirects.

**MFA fallback** — complete login interactively then save:
```bash
agent-browser open <loginUrl>
# fill fields, approve MFA…
agent-browser state save /workspace/group/.auth-states/<site>.json
```

## Commands (all accept `--auth <site>` to reuse a saved session)

```bash
pw screenshot <url> [out.png] [--full] [--auth <site>]
# prints saved path; default /tmp/screenshots/screenshot-<ts>.png

pw extract <url> '<js-expression>' [--auth <site>]
# evaluates JS in page context, prints JSON
# e.g. '[...document.querySelectorAll(".row")].map(r=>r.textContent.trim())'

pw html <url> [cssSelector] [--auth <site>]   # raw HTML of selector or full body
pw links <url> [--auth <site>]                # [{text,href}] JSON
```

Navigation retries automatically (3×, exponential back-off). Use `agent-browser wait` for element-level waits after loading.

## Session interop with agent-browser

```bash
# Load a pw-saved session in agent-browser
agent-browser state load /workspace/group/.auth-states/<site>.json
agent-browser open <url>
agent-browser snapshot -i
```
