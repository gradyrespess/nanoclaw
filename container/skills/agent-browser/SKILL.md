---
name: agent-browser
description: Browse the web for any task — research topics, read articles, interact with web apps, fill forms, take screenshots, extract data, and test web pages. Use whenever a browser would be useful, not just when the user explicitly asks.
allowed-tools: Bash(agent-browser:*)
---

# Browser Automation with agent-browser

```bash
agent-browser open <url>        # Navigate
agent-browser snapshot -i       # Get interactive elements + refs (@e1, @e2…)
agent-browser click @e1         # Act on refs from snapshot
agent-browser close
```

Re-snapshot after navigation or significant DOM changes.

## Commands

```bash
# Navigation
agent-browser open <url> | back | forward | reload | close

# Snapshot
agent-browser snapshot [-i] [-c] [-d <depth>] [-s "<css>"]
# -i interactive only (recommended), -c compact, -d depth limit, -s scope

# Interact (refs from snapshot)
agent-browser click|dblclick|hover @e1
agent-browser fill @e2 "text"          # clear + type
agent-browser type @e2 "text"          # type without clearing
agent-browser press Enter
agent-browser check|uncheck @e1
agent-browser select @e1 "value"
agent-browser scroll down 500
agent-browser upload @e1 file.pdf

# Get info
agent-browser get text|html|value @e1
agent-browser get attr @e1 href
agent-browser get title|url
agent-browser get count ".selector"

# Screenshots & PDF
agent-browser screenshot [path.png] [--full]
agent-browser pdf output.pdf

# Wait (retry / synchronize)
agent-browser wait @e1                  # element appears
agent-browser wait 2000                 # ms
agent-browser wait --text "Success"
agent-browser wait --url "**/dashboard"
agent-browser wait --load networkidle

# Semantic locators (alternative to refs)
agent-browser find role button click --name "Submit"
agent-browser find text "Sign In" click
agent-browser find label "Email" fill "user@test.com"
agent-browser find placeholder "Search" type "query"

# Auth state (save/restore cookies + localStorage)
agent-browser state save auth.json
agent-browser state load auth.json

# Cookies & storage
agent-browser cookies [set <name> <val>] [clear]
agent-browser storage local [set <k> <v>]

# JavaScript
agent-browser eval "document.title"
```
