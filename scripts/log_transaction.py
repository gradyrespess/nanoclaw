#!/usr/bin/env python3
"""
Log a pending budget transaction to Google Sheets and mark it confirmed in the DB.

Usage: python3 /workspace/project/scripts/log_transaction.py <short_id>
Example: python3 /workspace/project/scripts/log_transaction.py T1
"""

import sys
import sqlite3
import json
import os

BASE_DIR  = os.path.dirname(os.path.abspath(__file__))
DB_PATH   = os.path.join(BASE_DIR, '..', 'store', 'messages.db')
TOKEN_PATH = os.path.join(BASE_DIR, '.gcal-token.json')
SHEETS_ID  = '1XfQBEUbvf9JYpVgXlG6GGvKqhElG5B2OAgHgk-luT4M'
SHEETS_RANGE = 'Sheet1!A:D'
CLIENT_ID     = '103337039969-r3l429rdkvs2ndul3sujmvecmh8amtri.apps.googleusercontent.com'
CLIENT_SECRET = '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'

def main():
    if len(sys.argv) < 2:
        print("Usage: log_transaction.py <short_id>  e.g. T1")
        sys.exit(1)

    short_id = sys.argv[1].strip().upper()

    # ── Look up transaction in DB ─────────────────────────────────────────────
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    tx = db.execute(
        "SELECT * FROM budget_transactions WHERE short_id = ? AND status = 'pending'",
        (short_id,)
    ).fetchone()

    if not tx:
        # Check if it exists but isn't pending
        any_tx = db.execute(
            "SELECT * FROM budget_transactions WHERE short_id = ?", (short_id,)
        ).fetchone()
        if any_tx:
            print(f"Transaction {short_id} already {any_tx['status']} — nothing to log.")
        else:
            print(f"No pending transaction found with ID {short_id}.")
        db.close()
        sys.exit(1)

    # ── Build Google credentials from token file ──────────────────────────────
    if not os.path.exists(TOKEN_PATH):
        print(f"Token file not found at {TOKEN_PATH}")
        sys.exit(1)

    with open(TOKEN_PATH) as f:
        token_data = json.load(f)

    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request
    from googleapiclient.discovery import build

    creds = Credentials(
        token=token_data.get('access_token'),
        refresh_token=token_data.get('refresh_token'),
        token_uri='https://oauth2.googleapis.com/token',
        client_id=CLIENT_ID,
        client_secret=CLIENT_SECRET,
        scopes=['https://www.googleapis.com/auth/spreadsheets'],
    )

    # Refresh if expired
    if not creds.valid:
        creds.refresh(Request())
        token_data['access_token'] = creds.token
        with open(TOKEN_PATH, 'w') as f:
            json.dump(token_data, f, indent=2)

    # ── Append row to Google Sheets ───────────────────────────────────────────
    service = build('sheets', 'v4', credentials=creds, cache_discovery=False)
    service.spreadsheets().values().append(
        spreadsheetId=SHEETS_ID,
        range=SHEETS_RANGE,
        valueInputOption='USER_ENTERED',
        body={'values': [[tx['date'], tx['merchant'], float(tx['amount']), tx['category']]]}
    ).execute()

    # ── Mark confirmed in DB ──────────────────────────────────────────────────
    db.execute(
        "UPDATE budget_transactions SET status = 'confirmed' WHERE id = ?",
        (tx['id'],)
    )
    db.commit()
    db.close()

    print(f"✅ Logged ${float(tx['amount']):.2f} at {tx['merchant']} ({tx['category']}, {tx['date']}) to Google Sheets")

if __name__ == '__main__':
    main()
