#!/usr/bin/env python3
"""Send one bounded E2E turn through an authenticated Telegram user session.

Secrets are read only from the process environment.  The test never reads a
bot .env file and never prints credentials.  It deliberately uses MTProto: a
Telegram bot cannot initiate a 1:1 test conversation with another bot.
"""

import argparse
import asyncio
import json
import os
import time

from pyrogram import Client, filters
from pyrogram.handlers import EditedMessageHandler, MessageHandler


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bot", required=True)
    parser.add_argument("--message", required=True)
    parser.add_argument("--timeout", type=float, default=150)
    parser.add_argument("--expect-silence", action="store_true")
    args = parser.parse_args()

    try:
        api_id = int(os.environ["TG_API_ID"])
        api_hash = os.environ["TG_API_HASH"]
    except KeyError as error:
        print(json.dumps({"status": "SKIP", "reason": f"missing {error.args[0]}"}))
        return 2

    session = os.environ.get("WELLE0_TG_SESSION", "nexusgram_e2e")
    workdir = os.environ.get("WELLE0_TG_WORKDIR", ".")
    client = Client(session, api_id=api_id, api_hash=api_hash, workdir=workdir)
    reply = ""
    changed = 0.0
    any_activity = ""  # silence checks: even a thinking placeholder is a violation

    # Streaming bots first post a thinking placeholder and then EDIT it into the
    # real answer (memory: feedback-pyrogram-streaming-edit-detection). The
    # placeholder must never count as the reply, or every slow turn "settles" on
    # "Denke nach..." and content checks fail against the wrong text.
    def is_placeholder(text: str) -> bool:
        stripped = text.strip()
        if not stripped:
            return True
        if "denke nach" in stripped.lower():
            return True
        return stripped[0] in "◐◓◑◒⏳…"

    # The bot may answer across SEVERAL messages (streamed answer bubble plus a
    # separate "⏱ 8s" timing footer). Capturing only the newest message hands
    # the content checks the footer instead of the answer — collect every
    # non-placeholder bot message of this turn, keyed by message id.
    parts: dict[int, str] = {}

    async def record(_client, message):
        nonlocal reply, changed, any_activity
        text = (message.text or message.caption or "").strip()
        if text:
            any_activity = text
        if text and not is_placeholder(text):
            parts[message.id] = text
            reply = "\n".join(parts[key] for key in sorted(parts))
            changed = time.monotonic()

    handler_filter = filters.chat(args.bot) & filters.bot
    client.add_handler(MessageHandler(record, handler_filter))
    client.add_handler(EditedMessageHandler(record, handler_filter))
    await client.start()
    try:
        started = time.monotonic()
        await client.send_message(args.bot, args.message)
        while time.monotonic() - started < args.timeout:
            await asyncio.sleep(0.5)
            if args.expect_silence and any_activity:
                print(json.dumps({"status": "FAIL", "reason": "unexpected bot reply", "reply": any_activity}, ensure_ascii=False))
                return 1
            if reply and time.monotonic() - changed >= 6:
                print(json.dumps({"status": "PASS", "reply": reply}, ensure_ascii=False))
                return 0
        if args.expect_silence:
            print(json.dumps({"status": "PASS", "reply": ""}))
            return 0
        print(json.dumps({"status": "FAIL", "reason": "reply timeout", "reply": reply}, ensure_ascii=False))
        return 1
    finally:
        await client.stop()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
