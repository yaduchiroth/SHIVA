"""Shruti — the alert that watches the inbox.

Polls Gmail over IMAP (app password) for unseen mail and interrupts
proactively. Also exposes a draft-reply tool: drafts are written into
[Gmail]/Drafts via IMAP, so they appear in the Gmail app for review —
human stays in the loop, nothing is auto-sent.
"""
import asyncio
import email
import email.header
import email.message
import imaplib
import time
from typing import Any

from claude_agent_sdk import tool

from .tools_mac import _CTX, _ok

_LAST_EMAIL: dict = {}


def _decode(value: str) -> str:
    parts = email.header.decode_header(value or "")
    out = ""
    for text, enc in parts:
        out += text.decode(enc or "utf-8", errors="replace") if isinstance(text, bytes) else text
    return out.strip()


class Shruti:
    def __init__(self, cfg, bus, brain) -> None:
        self.cfg = cfg
        self.bus = bus
        self.brain = brain
        self.seen: set[bytes] = set()
        self.first_pass = True

    def _connect(self) -> imaplib.IMAP4_SSL:
        conn = imaplib.IMAP4_SSL("imap.gmail.com")
        conn.login(self.cfg.gmail_address, self.cfg.gmail_app_password)
        return conn

    def _poll_once(self) -> list[dict]:
        conn = self._connect()
        try:
            conn.select("INBOX")
            _, data = conn.search(None, "UNSEEN")
            ids = data[0].split()
            fresh = [i for i in ids if i not in self.seen]
            out = []
            for i in fresh[-5:]:  # cap per cycle
                _, msg_data = conn.fetch(i, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT MESSAGE-ID)])")
                raw = msg_data[0][1] if msg_data and msg_data[0] else b""
                msg = email.message_from_bytes(raw)
                out.append({
                    "from": _decode(msg.get("From", "")),
                    "subject": _decode(msg.get("Subject", "(no subject)")),
                    "message_id": msg.get("Message-ID", ""),
                })
            self.seen.update(ids)
            return out
        finally:
            try:
                conn.logout()
            except Exception:
                pass

    async def run(self) -> None:
        if not (self.cfg.gmail_address and self.cfg.gmail_app_password):
            await self.bus.log("shruti disabled (no GMAIL_ADDRESS/GMAIL_APP_PASSWORD)")
            return
        await self.bus.log("shruti is watching the inbox")
        loop = asyncio.get_running_loop()
        while True:
            try:
                fresh = await loop.run_in_executor(None, self._poll_once)
                if self.first_pass:
                    self.first_pass = False  # don't announce the backlog on boot
                else:
                    for m in fresh:
                        _LAST_EMAIL.update(m)
                        sender = m["from"].split("<")[0].strip().strip('"') or m["from"]
                        await self.bus.alert(f"Email from {sender}", m["subject"])
                        await self.brain.interject(
                            f"[Shruti reports] A new email just arrived from {m['from']} "
                            f"with subject: \"{m['subject']}\". Briefly announce it aloud "
                            f"and ask if you should draft a reply."
                        )
            except Exception as e:
                await self.bus.log(f"shruti error: {e}")
            await asyncio.sleep(self.cfg.shruti_poll_seconds)


# ---------------------------------------------------------------------------
@tool("draft_email", "Create a Gmail draft (never sends). Use after the user approves "
      "drafting a reply. If replying to the email Shruti just announced, set "
      "reply_to_last=True.", {"to": str, "subject": str, "body": str, "reply_to_last": bool})
async def draft_email(args: dict[str, Any]) -> dict[str, Any]:
    cfg = _CTX.get("cfg")
    if not (cfg and cfg.gmail_address and cfg.gmail_app_password):
        return _ok("Gmail not configured — set GMAIL_ADDRESS and GMAIL_APP_PASSWORD in .env.")

    msg = email.message.EmailMessage()
    msg["From"] = cfg.gmail_address
    msg["To"] = args["to"]
    msg["Subject"] = args["subject"]
    if args.get("reply_to_last") and _LAST_EMAIL.get("message_id"):
        msg["In-Reply-To"] = _LAST_EMAIL["message_id"]
        msg["References"] = _LAST_EMAIL["message_id"]
    msg.set_content(args["body"])

    def _append() -> str:
        conn = imaplib.IMAP4_SSL("imap.gmail.com")
        conn.login(cfg.gmail_address, cfg.gmail_app_password)
        try:
            conn.append('"[Gmail]/Drafts"', "",
                        imaplib.Time2Internaldate(time.time()), msg.as_bytes())
            return "Draft created — it's in Gmail Drafts for review."
        finally:
            try:
                conn.logout()
            except Exception:
                pass

    try:
        result = await asyncio.get_running_loop().run_in_executor(None, _append)
        return _ok(result)
    except Exception as e:
        return _ok(f"Draft failed: {e}")


SHRUTI_TOOLS = [draft_email]
