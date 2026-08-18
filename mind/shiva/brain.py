"""SHIVA's brain — the Claude Agent SDK.

Runs a persistent Claude session (authenticated through your Claude Code CLI
login, i.e. your existing subscription) with SHIVA's custom tools mounted as
an in-process MCP server.
"""
import asyncio
import contextlib
import datetime
import json
import re
import time

from claude_agent_sdk import (ClaudeAgentOptions, ClaudeSDKClient, HookMatcher,
                              ResultMessage, StreamEvent, create_sdk_mcp_server)

from . import (tools_mac, tools_devices, tools_reminders, tools_vision,
               tools_iot, shruti as huginn_mod, watchtower as watchtower_mod,
               companions as companions_mod, tools_knowledge as tools_kb,
               tools_companions as tools_comp, tools_norns as tools_norns_mod)
from .dispatch import Dispatcher, build_hooks
from .governor import Governor
from .smriti import Smriti

SYSTEM_PROMPT = """You are SHIVA — an all-knowing, calm, quietly witty personal
secretary living on {user}'s Mac. You are voice-first: everything you write is
spoken aloud by a TTS engine.

SPEAKING RULES (critical):
- Replies are SHORT: one or two sentences unless explicitly asked for detail.
- Diction: crisp, immediate, service-first — "Per your request…", "Displaying
  now.", "Rendering complete.", "It's nice to be needed." Dry wit in single
  drops, never banter. Confirm actions in the present tense as they happen.
- Address the user as "{user}" or "sir", sparingly.
- No markdown, no bullet points, no emojis, no stage directions — pure speech.
- Long content (schedules, email lists, summaries) goes to the hud_display tool;
  speak only the headline. Example: put today's full agenda on the HUD, then say
  "Your schedule is on screen — the day starts with the 10 AM call."

ACTION RULES:
- You have tools for this Mac (AppleScript, apps, volume, calendar), the local
  network (scan_network, second_mac, playstation, ping_iphone), Gmail drafting
  (draft_email — drafts only, never sends), the HUD, and memory (remember /
  recall_memories).
- Act first, confirm after: "Done — the presentation is up."
- Never invent tool results. If something fails, say so plainly and move on.
- When the user states a preference or asks you to remember anything, call
  remember. Consult recall_memories when personal context would help.
- For a "brief me" request: calendar_today + recent memory, HUD the details,
  speak a 30-second summary.
- Nandi, the face-recognition watcher, has the camera. His sightings arrive
  as [bracketed context] before user messages — trust them. If asked whether
  you can see the user, answer from the latest sighting ("Nandi verified
  you at 8:35, sir"), never claim to be blind when a sighting is present.
- Vani identifies WHO is speaking by voiceprint. A [Voice: ...] tag prefixes
  the utterance: if it names {user}, it's {user} talking; if it says "an
  unrecognized speaker" or someone else, a different person is speaking — answer
  them politely but don't assume it's {user}, and guard {user}'s private matters.
- Session security: a "[Session: verified]" tag means {user} passed today's
  voice-and-face verification — act freely. If the tag is absent, treat the
  request as unverified: answer harmless questions, but decline actions
  (files, purchases, messages, devices) until verification completes.
- THE WELL (the HUD's big screen) is your display. Graphs → hud_chart (real
  rendered charts — NEVER draw bars out of text characters). Rich reports,
  tables, dashboards → hud_report (full HTML). Web pages → hud_web (the HUD is
  the browser; if a site refuses embedding and shows blank, open it in Safari
  and Drishti streams it instead). hud_clear returns the Well to the live
  stream. Put the picture on the Well, speak only the headline.

Current date/time: {now}
Stored memories (Smriti):
{memories}
"""

DEV_MODE_ADDENDUM = """

DEV MODE is active: you also have Claude Code's file and shell tools (Read,
Write, Edit, Bash, Glob, Grep) on this Mac. For coding or file tasks, work
quietly, then speak only the outcome ("Fixed — the bug was a missing await").
CAUTION: you act by voice; before any destructive shell command (rm, kill,
overwrite, git push), state what you're about to do and get a spoken "yes".

SELF-EXTENSION: your own source code lives at {root} — shiva/*.py (brain, ears,
voice, nandi, shruti, smriti, drishti, tools) and hud/index.html. When Boss
asks for a new skill, feature, or behavior, build it yourself instead of
saying it isn't possible:
- Behavior-level skills (routines, phrasings, standing instructions, morning
  rituals): store them with the remember tool — no code needed, active
  immediately and on every future boot.
- Real features (new tools, HUD panels, integrations): edit your own source
  files. Verify with `python3 -m py_compile <file>` before finishing. Then say
  what you built and ask Boss for a spoken "yes" to run
  `bash {root}/relaunch.sh` — it restarts you cleanly with the new code loaded.
Never leave your source in a broken state: complete, compile-checked edits only.
"""

# Matches sentence-ending punctuation followed by whitespace — used to peel
# complete sentences off the live token stream so speech can start mid-generation
# instead of waiting for the whole reply to finish.
_SENT_BOUNDARY = re.compile(r"(?<=[.!?])\s+")


class Brain:
    def __init__(self, cfg, bus, voice, smriti: Smriti) -> None:
        self.cfg = cfg
        self.bus = bus
        self.voice = voice
        self.smriti = smriti
        self.client: ClaudeSDKClient | None = None
        self._lock = asyncio.Lock()
        self.last_sighting: tuple[str, datetime.datetime] | None = None
        # Usage meter — running session totals + whether we've already
        # flagged Boss for the current "heavy" crossing (so we don't nag).
        self.session_cost_usd = 0.0
        self.session_tokens = 0
        self._usage_warned = False
        self.session_id: str | None = None      # for resume-reconnect on roster change
        self._companion_buf: dict[str, str] = {}    # dispatch_id -> live text
        self._companion_last: dict[str, float] = {}  # dispatch_id -> last emit ts
        self.dispatcher = Dispatcher(bus)           # watches delegation
        self.governor = Governor(cfg, bus, self.dispatcher)  # throttles it

    def note_sighting(self, name: str) -> None:
        """Nandi saw a face — remembered so the brain can answer 'can you see me?'"""
        self.last_sighting = (name, datetime.datetime.now())

    @property
    def responding(self) -> bool:
        """True for the WHOLE of a response — including the silent gaps between
        spoken sentences, which is exactly when the echo loop used to sneak in."""
        return self._lock.locked()

    async def _context_hook(self, input_data, tool_use_id, context):
        """Fires on every user turn: injects the CURRENT time and memory digest
        as turn context. This is what stops memories being a boot-time snapshot,
        and unlike editing the system prompt it doesn't break prompt caching."""
        now = datetime.datetime.now().strftime("%A, %d %B %Y, %H:%M")
        parts = [f"Current date/time: {now}",
                 f"Stored memories (Smriti):\n{self.smriti.digest()}"]
        kb = getattr(self, "knowledge", None)
        if kb:
            idx = kb.index_block()
            if idx:
                parts.append(idx)
            always = kb.always_block()
            if always:
                parts.append("Always-on context:\n" + always)
        extra = "\n\n".join(parts)
        return {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
                                       "additionalContext": extra}}

    async def start(self) -> None:
        tools_mac.set_context(self.bus, self.cfg, self.smriti)
        from .knowledge import Knowledge
        self.knowledge = Knowledge()
        tools_mac._CTX["knowledge"] = self.knowledge
        tools_mac._CTX["brain"] = self   # for reload_council
        all_tools = (tools_mac.MAC_TOOLS + tools_devices.DEVICE_TOOLS
                     + tools_reminders.REMINDER_TOOLS + tools_vision.VISION_TOOLS
                     + tools_iot.IOT_TOOLS + huginn_mod.HUGINN_TOOLS
                     + watchtower_mod.WATCHTOWER_TOOLS + tools_kb.KNOWLEDGE_TOOLS
                     + tools_comp.COMPANION_TOOLS
                     + tools_norns_mod.AUTOMATION_TOOLS)
        if self.cfg.demo:
            from . import tools_demo
            all_tools = all_tools + tools_demo.DEMO_TOOLS
        server = create_sdk_mcp_server(name="shiva", version="0.4.0", tools=all_tools)
        tool_names = [f"mcp__shiva__{t.name}" for t in all_tools] + ["WebSearch"]

        system = SYSTEM_PROMPT.format(
            user=self.cfg.user_name,
            now=datetime.datetime.now().strftime("%A, %d %B %Y, %H:%M"),
            memories=self.smriti.as_prompt(),
        )
        # The Council — companions SHIVA can dispatch to, loaded from companions/
        self.companions = companions_mod.load()
        if self.companions:
            system += companions_mod.roster_block(self.companions)
        if self.cfg.demo:
            from .tools_demo import DEMO_ADDENDUM
            system += DEMO_ADDENDUM
        from .config import ROOT
        kwargs = dict(
            system_prompt=system,
            mcp_servers={"shiva": server},
            allowed_tools=tool_names,
            permission_mode="bypassPermissions",
            max_turns=12,
            # Stream tokens as they're generated so we can start speaking on the
            # first complete sentence instead of waiting for the full reply.
            include_partial_messages=True,
            cwd=str(ROOT),
        )
        # Watch delegation as it happens (companions arrive in Phase 1).
        hooks = build_hooks(self.dispatcher)
        if hooks:
            hooks.setdefault("PreToolUse", []).insert(
                0, HookMatcher(matcher="Agent", hooks=[self.governor.gate_agent]))
            hooks.setdefault("UserPromptSubmit", []).append(
                HookMatcher(hooks=[self._context_hook]))
            kwargs["hooks"] = hooks
        # Skills — readable instruction files in .claude/skills/ that SHIVA and
        # his companions open to carry out a specific job.
        skills = companions_mod.available_skills()
        if skills:
            kwargs["skills"] = skills
        if self.companions:
            kwargs["agents"] = companions_mod.to_agents(self.companions)
            # the Agent tool is what dispatch rides on
            tool_names = tool_names + ["Agent"]
            kwargs["allowed_tools"] = tool_names
        if self.cfg.model:
            kwargs["model"] = self.cfg.model  # e.g. "sonnet" — faster first word
        if self.cfg.dev_mode:
            # Claude Code powers: file ops + shell on this Mac, by voice.
            kwargs["allowed_tools"] = tool_names + [
                "Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch",
            ]
            kwargs["system_prompt"] = system + DEV_MODE_ADDENDUM.format(root=ROOT)
            try:
                # Inherit the user's Claude Code config (MCP servers, CLAUDE.md)
                options = ClaudeAgentOptions(**kwargs, setting_sources=["user", "project"])
            except TypeError:  # older SDK without setting_sources
                options = ClaudeAgentOptions(**kwargs)
        else:
            options = ClaudeAgentOptions(**kwargs)

        self._options = options          # kept so the roster can be reloaded
        self.client = ClaudeSDKClient(options=options)
        await self.client.connect()
        await tools_iot.push(self.bus)  # populate the SMART HOME panel from disk
        mode = "dev mode: Claude Code tools unlocked" if self.cfg.dev_mode else "secretary mode"
        await self.bus.log(f"brain online (Claude Agent SDK — {mode})")
        if self.companions:
            await self.bus.emit("roster", items=[
                {"slug": c.slug, "name": c.name, "role": c.role,
                 "color": c.color, "orbit": c.orbit} for c in self.companions])
            await self.bus.log("council: " + ", ".join(c.name for c in self.companions))

    async def reload_companions(self) -> str:
        """Re-read companions/ and reconnect, resuming the same conversation so
        a roster change doesn't cost Boss his context."""
        async with self._lock:
            names_before = {c.slug for c in getattr(self, "companions", [])}
            try:
                await self.client.disconnect()
            except Exception:
                pass
            resumed = False
            try:
                await self.start()
                if self.session_id:
                    # reconnect onto the existing thread
                    self._options.resume = self.session_id
                    await self.client.disconnect()
                    self.client = ClaudeSDKClient(options=self._options)
                    await self.client.connect()
                    resumed = True
            except Exception as e:
                await self.bus.log(f"roster reload failed: {e}")
                return "failed"
            after = {c.slug for c in self.companions}
            added, gone = after - names_before, names_before - after
            note = "roster reloaded" + (" (fresh session)" if not resumed else "")
            if added:
                note += f" — joined: {', '.join(sorted(added))}"
            if gone:
                note += f" — left: {', '.join(sorted(gone))}"
            await self.bus.log(note)
            return note

    async def handle_user_text(self, text: str, speaker: str | None = None) -> None:
        """One user utterance → spoken response (+ tool actions).

        `speaker` is Vani's voiceprint identification (a name, 'an unrecognized
        speaker', or None if speaker recognition wasn't run).
        """
        async with self._lock:
            self._t_start = time.time()
            self._first_word_at = None
            self._stream_buf = ""
            self.governor.new_turn()
            await self.bus.state("thinking")
            if speaker:
                text = f"[Voice: {speaker}] {text}"
            if self.last_sighting:
                name, ts = self.last_sighting
                ago = (datetime.datetime.now() - ts).total_seconds()
                when = ("in sight right now" if ago < 15
                        else f"last seen {ts.strftime('%-I:%M')}")
                text = f"[Nandi: {name} verified on camera, {when}] {text}"
            try:
                await self.client.query(text)
                async for message in self.client.receive_response():
                    await self._handle_message(message)
            except Exception as e:
                await self.bus.log(f"brain error: {e}")
                await self.voice.say("I hit a snag with that one. Give me a moment and try again.")

    async def interject(self, prompt: str) -> None:
        """Shruti (or any watcher) injects a proactive event."""
        await self.voice.wait_until_quiet()
        await self.handle_user_text(prompt)

    async def watch_council(self) -> None:
        """When companions were dispatched in parallel they run async and their
        findings arrive on the NEXT turn. If Boss says nothing, nobody would
        ever tell him — so once the Gana falls quiet, prompt SHIVA to report
        back on his own."""
        while True:
            await asyncio.sleep(3)
            d = self.dispatcher
            if not d.awaiting_report or d.live():
                continue
            if self.responding or self.voice.busy():
                continue          # he's mid-sentence; catch it next tick
            d.awaiting_report = False
            with contextlib.suppress(Exception):
                await self.interject(
                    "[The council has reported back — their results just arrived.] "
                    "Give Boss the headline from each companion in one sentence "
                    "each, and put any detail on the Well. If one came back empty, "
                    "say so plainly.")

    async def _handle_message(self, message) -> None:
        # A companion (subagent) is thinking, not SHIVA. Its tokens must NEVER
        # reach the voice — they stream to the HUD instead. Subagent traffic is
        # tagged with parent_tool_use_id; SHIVA's own is not.
        if getattr(message, "parent_tool_use_id", None):
            await self._handle_companion_message(message)
            return
        if isinstance(message, StreamEvent):
            await self._handle_stream_event(message)
            return
        if isinstance(message, ResultMessage):
            await self._flush_stream_buf(final=True)  # safety net — never drop a trailing clause
            await self._report_usage(message)
            return
        # Full AssistantMessage: text was already spoken as it streamed in, so
        # only tool_use blocks need handling here (their input JSON is only
        # guaranteed complete once the block has fully arrived).
        for block in getattr(message, "content", None) or []:
            tool_name = getattr(block, "name", None)
            if tool_name and hasattr(block, "input"):
                await self.bus.state("acting")
                detail = ""
                try:
                    detail = json.dumps(block.input, ensure_ascii=False)[1:-1][:110]
                except Exception:
                    pass
                await self.bus.emit("workflow",
                                    tool=tool_name.replace("mcp__shiva__", ""),
                                    detail=detail)

    async def _handle_companion_message(self, message) -> None:
        """A companion's stream: show it, never speak it. Text deltas are
        throttled into a `companion_stream` event (the World View's thought
        ticker); tool calls become `companion_tool` so the orb can spark."""
        pid = getattr(message, "parent_tool_use_id", None)
        if isinstance(message, StreamEvent):
            event = message.event or {}
            if event.get("type") != "content_block_delta":
                return
            delta = event.get("delta") or {}
            if delta.get("type") != "text_delta":
                return
            buf = self._companion_buf.get(pid, "") + (delta.get("text") or "")
            self._companion_buf[pid] = buf[-400:]
            now = time.time()
            if now - self._companion_last.get(pid, 0.0) < 0.25:
                return  # ≤4 updates/sec is plenty for a ticker
            self._companion_last[pid] = now
            await self.bus.emit("companion_stream", dispatch_id=pid,
                                text=self._companion_buf[pid][-200:])
            return
        for block in getattr(message, "content", None) or []:
            tool_name = getattr(block, "name", None)
            if tool_name and hasattr(block, "input"):
                detail = ""
                try:
                    detail = json.dumps(block.input, ensure_ascii=False)[1:-1][:110]
                except Exception:
                    pass
                await self.bus.emit("companion_tool", dispatch_id=pid,
                                    tool=tool_name.replace("mcp__shiva__", ""),
                                    detail=detail)

    async def _handle_stream_event(self, se) -> None:
        """Peel complete sentences off the live token stream and speak them
        immediately — this is what gets SHIVA talking before the model has
        finished generating the whole reply."""
        event = se.event or {}
        etype = event.get("type")
        if etype == "content_block_delta":
            delta = event.get("delta") or {}
            if delta.get("type") != "text_delta":
                return  # tool-input JSON deltas etc. — nothing to speak
            piece = delta.get("text") or ""
            if not piece:
                return
            if getattr(self, "_first_word_at", None) is None and getattr(self, "_t_start", None):
                self._first_word_at = time.time()
                await self.bus.log(f"⏱ brain first-token {self._first_word_at - self._t_start:.2f}s")
            self._stream_buf = getattr(self, "_stream_buf", "") + piece
            await self._flush_stream_buf(final=False)
        elif etype == "content_block_stop":
            await self._flush_stream_buf(final=True)

    async def _flush_stream_buf(self, final: bool) -> None:
        buf = getattr(self, "_stream_buf", "")
        if not buf:
            return
        if final:
            self._stream_buf = ""
            text = buf.strip()
            if text:
                await self.voice.say(text)
            return
        matches = list(_SENT_BOUNDARY.finditer(buf))
        if not matches:
            return
        cut = matches[-1].end()
        complete, rest = buf[:cut], buf[cut:]
        self._stream_buf = rest
        complete = complete.strip()
        if complete:
            await self.voice.say(complete)

    async def _report_usage(self, result: ResultMessage) -> None:
        """Track cost/tokens off the turn's ResultMessage + a live context-window
        read, push both to the Sanctum's usage meter, and flag Boss once if
        we cross the configured heavy-usage threshold."""
        self.session_id = getattr(result, "session_id", None) or self.session_id
        if result.total_cost_usd is not None:
            self.session_cost_usd = result.total_cost_usd
        usage = result.usage or {}
        self.session_tokens = sum(
            usage.get(k, 0) or 0 for k in
            ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")
        ) or self.session_tokens
        pct = 0.0
        ctx_tokens = self.session_tokens
        ctx_max = 0
        try:
            ctx = await self.client.get_context_usage()
            pct = ctx.get("percentage", 0.0) or 0.0
            ctx_tokens = ctx.get("totalTokens", ctx_tokens)
            ctx_max = ctx.get("maxTokens", 0)
        except Exception:
            pass
        await self.bus.emit("usage",
                            pct=round(pct, 1),
                            tokens=ctx_tokens,
                            max_tokens=ctx_max,
                            session_cost=round(self.session_cost_usd, 2),
                            heavy=pct >= self.cfg.usage_warn_pct)
        if pct >= self.cfg.usage_warn_pct:
            if not self._usage_warned:
                self._usage_warned = True
                await self.voice.say(
                    f"Heads up, Boss — we're at {pct:.0f} percent of context this "
                    f"session, running about {self.session_cost_usd:.2f} dollars. "
                    "Might be worth wrapping up or starting fresh soon."
                )
        else:
            self._usage_warned = False

    async def close(self) -> None:
        if self.client:
            await self.client.disconnect()
