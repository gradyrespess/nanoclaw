#!/usr/bin/env python3
"""
Budget tracker query tool for NanoClaw agents.

Usage:
  python3 /workspace/project/scripts/budget-query.py recent [N]
  python3 /workspace/project/scripts/budget-query.py week
  python3 /workspace/project/scripts/budget-query.py month
  python3 /workspace/project/scripts/budget-query.py pending
  python3 /workspace/project/scripts/budget-query.py search TERM
  python3 /workspace/project/scripts/budget-query.py category CATEGORY
"""

import sqlite3
import sys
import os
from datetime import datetime, timedelta

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'store', 'messages.db')

def get_db():
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    return db

def fmt_row(r):
    status_mark = {'confirmed': '✓', 'dismissed': '✗', 'pending': '?'}.get(r['status'], '?')
    short = f"[{r['short_id']}]" if r['short_id'] else ''
    return f"{status_mark} {r['date']}  ${r['amount']:.2f}  {r['merchant']}  ({r['category']}) {short}"

def cmd_recent(args):
    n = int(args[0]) if args else 10
    db = get_db()
    rows = db.execute(
        "SELECT * FROM budget_transactions ORDER BY created_at DESC LIMIT ?", (n,)
    ).fetchall()
    if not rows:
        print("No transactions found.")
        return
    print(f"Last {len(rows)} transactions:")
    for r in rows:
        print(fmt_row(r))

def cmd_week(args):
    # Current week Mon-Sun
    today = datetime.now()
    start = today - timedelta(days=today.weekday())
    start = start.replace(hour=0, minute=0, second=0, microsecond=0)
    db = get_db()
    rows = db.execute(
        "SELECT * FROM budget_transactions WHERE status='confirmed' AND created_at >= ? ORDER BY created_at",
        (start.isoformat(),)
    ).fetchall()
    if not rows:
        print(f"No confirmed transactions this week (since {start.strftime('%a %b %d')}).")
        return
    totals = {}
    for r in rows:
        totals[r['category']] = totals.get(r['category'], 0) + r['amount']
    grand = sum(totals.values())
    print(f"This week ({start.strftime('%b %d')} – {today.strftime('%b %d')}):")
    for cat, amt in sorted(totals.items(), key=lambda x: -x[1]):
        print(f"  {cat}: ${amt:.2f}")
    print(f"  Total: ${grand:.2f}")
    print(f"\n{len(rows)} transaction(s):")
    for r in rows:
        print(f"  {fmt_row(r)}")

def cmd_month(args):
    today = datetime.now()
    start = today.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    db = get_db()
    rows = db.execute(
        "SELECT * FROM budget_transactions WHERE status='confirmed' AND created_at >= ? ORDER BY created_at",
        (start.isoformat(),)
    ).fetchall()
    if not rows:
        print(f"No confirmed transactions this month (since {start.strftime('%b %d')}).")
        return
    totals = {}
    for r in rows:
        totals[r['category']] = totals.get(r['category'], 0) + r['amount']
    grand = sum(totals.values())
    print(f"This month ({start.strftime('%B')}):")
    for cat, amt in sorted(totals.items(), key=lambda x: -x[1]):
        print(f"  {cat}: ${amt:.2f}")
    print(f"  Total: ${grand:.2f}")
    print(f"\n{len(rows)} transaction(s):")
    for r in rows:
        print(f"  {fmt_row(r)}")

def cmd_pending(args):
    db = get_db()
    rows = db.execute(
        "SELECT * FROM budget_transactions WHERE status='pending' ORDER BY created_at"
    ).fetchall()
    if not rows:
        print("No pending transactions.")
        return
    print(f"{len(rows)} pending transaction(s):")
    for r in rows:
        print(fmt_row(r))

def cmd_search(args):
    if not args:
        print("Usage: search TERM")
        return
    term = f"%{'%'.join(args)}%"
    db = get_db()
    rows = db.execute(
        "SELECT * FROM budget_transactions WHERE merchant LIKE ? ORDER BY created_at DESC LIMIT 20",
        (term,)
    ).fetchall()
    if not rows:
        print(f"No transactions matching '{' '.join(args)}'.")
        return
    print(f"{len(rows)} match(es):")
    for r in rows:
        print(fmt_row(r))

def cmd_category(args):
    if not args:
        print("Usage: category CATEGORY")
        return
    cat = args[0].capitalize()
    db = get_db()
    rows = db.execute(
        "SELECT * FROM budget_transactions WHERE category=? AND status='confirmed' ORDER BY created_at DESC LIMIT 20",
        (cat,)
    ).fetchall()
    if not rows:
        print(f"No confirmed transactions in category '{cat}'.")
        return
    total = sum(r['amount'] for r in rows)
    print(f"{cat}: {len(rows)} transaction(s), ${total:.2f} total")
    for r in rows:
        print(f"  {fmt_row(r)}")

COMMANDS = {
    'recent': cmd_recent,
    'week': cmd_week,
    'month': cmd_month,
    'pending': cmd_pending,
    'search': cmd_search,
    'category': cmd_category,
}

if __name__ == '__main__':
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(__doc__)
        sys.exit(1)
    COMMANDS[sys.argv[1]](sys.argv[2:])
