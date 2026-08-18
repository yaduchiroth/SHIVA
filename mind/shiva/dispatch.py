"""Dispatch — watching SHIVA delegate.

The Claude Agent SDK fires lifecycle hooks around subagents. We use them as a
pure observation layer: every hook returns {} (never blocks, never speaks) and
just publishes bus events so the HUD and the World View can draw the work.

The correlation problem: PreToolUse on the `Agent` tool carries the task text
keyed by tool_use_id, while SubagentStart carries agent_id + agent_type and NO
prompt. They are different identifiers, so we bind them through a per-type FIFO
of pending dispatches — the oldest unbound dispatch of that type wins.

Events published:
    dispatch        {id, slug, task, ts}          SHIVA hands work to a companion
    companion       {id, slug, state}             working | idle
    companion_tool  {dispatch_id, tool, detail}   a companion used a tool
    dispatch_return {id, slug, ok, summary, dur}  work came home
    dispatch_clear  {}                            turn over, sweep the board
"""
import collections
import contextlib
import json
import time


class Dispatcher:
    def __init__(self, bus) -> None:
        self.bus = bus
        self.by_tool_use: dict[str, dict] = {}      # tool_use_id -> dispatch record
        self.by_agent: dict[str, str] = {}          # agent_id -> tool_use_id
        self.pending: dict[str, collections.deque] = {}  # slug -> [tool_use_id]
        self.awaiting_report = False   # async companions finished, Boss not told yet

    # ── helpers ────────────────────────────────────────────────────────────
    def _rec(self, tool_use_id: str) -> dict | None:
        return self.by_tool_use.get(tool_use_id)

    def live(self) -> int:
        return sum(1 for r in self.by_tool_use.values() if not r.get("done"))

    # ── hook callbacks (all return {} — observe only) ──────────────────────
    async def on_pre_tool(self, input_data, tool_use_id, context):
        tool = (input_data or {}).get("tool_name") or ""
        args = (input_data or {}).get("tool_input") or {}

        if tool == "Agent":
            slug = args.get("subagent_type") or "general-purpose"
            task = (args.get("description") or args.get("prompt") or "")[:300]
            rec = {"id": tool_use_id, "slug": slug, "task": task,
                   "t0": time.time(), "done": False}
            self.by_tool_use[tool_use_id] = rec
            self.pending.setdefault(slug, collections.deque()).append(tool_use_id)
            with contextlib.suppress(Exception):
                await self.bus.emit("dispatch", id=tool_use_id, slug=slug, task=task)
            return {}

        # a tool call from INSIDE a companion carries its agent_id
        agent_id = (input_data or {}).get("agent_id")
        if agent_id:
            tuid = self.by_agent.get(agent_id)
            rec = self._rec(tuid) if tuid else None
            detail = ""
            with contextlib.suppress(Exception):
                detail = json.dumps(args, ensure_ascii=False)[1:-1][:110]
            with contextlib.suppress(Exception):
                await self.bus.emit("companion_tool", dispatch_id=tuid,
                                    slug=(rec or {}).get("slug"),
                                    tool=tool.replace("mcp__shiva__", ""),
                                    detail=detail)
        return {}

    async def on_subagent_start(self, input_data, tool_use_id, context):
        data = input_data or {}
        agent_id = data.get("agent_id")
        slug = data.get("agent_type") or "general-purpose"
        queue = self.pending.get(slug)
        tuid = queue.popleft() if queue else None
        if tuid is None:
            # started without a PreToolUse we saw — synthesize rather than drop
            tuid = f"synth-{agent_id}"
            self.by_tool_use[tuid] = {"id": tuid, "slug": slug, "task": "",
                                      "t0": time.time(), "done": False}
            with contextlib.suppress(Exception):
                await self.bus.emit("dispatch", id=tuid, slug=slug, task="")
        if agent_id:
            self.by_agent[agent_id] = tuid
        with contextlib.suppress(Exception):
            await self.bus.emit("companion", id=tuid, slug=slug, state="working")
        return {}

    async def on_post_tool(self, input_data, tool_use_id, context):
        data = input_data or {}
        if (data.get("tool_name") or "") != "Agent":
            return {}
        rec = self._rec(tool_use_id)
        if not rec:
            return {}
        summary = ""
        resp = data.get("tool_response")
        with contextlib.suppress(Exception):
            summary = (resp if isinstance(resp, str) else json.dumps(resp))[:300]
        # An async launch returns immediately — the companion is still working,
        # so don't mark it done or the Stop sweep will erase a live dispatch.
        if isinstance(resp, dict) and resp.get("isAsync"):
            rec["async"] = True   # still running; results land via task notification
            return {}
        rec["done"] = True
        with contextlib.suppress(Exception):
            await self.bus.emit("dispatch_return", id=rec["id"], slug=rec["slug"],
                                ok=True, summary=summary,
                                dur=round(time.time() - rec["t0"], 1))
        return {}

    async def on_subagent_stop(self, input_data, tool_use_id, context):
        agent_id = (input_data or {}).get("agent_id")
        tuid = self.by_agent.pop(agent_id, None) if agent_id else None
        rec = self._rec(tuid) if tuid else None
        if rec:
            rec["done"] = True   # an async companion finishing closes its beam
            if rec.get("async"):
                self.awaiting_report = True   # Boss is owed a report
        with contextlib.suppress(Exception):
            await self.bus.emit("companion", id=tuid,
                                slug=(rec or {}).get("slug"), state="idle")
        return {}

    async def on_stop(self, input_data, tool_use_id, context):
        """Turn is over — sweep the board, but never while companions are still
        working (async dispatches outlive the turn that launched them)."""
        if self.live():
            return {}
        self.by_tool_use.clear()
        self.by_agent.clear()
        self.pending.clear()
        with contextlib.suppress(Exception):
            await self.bus.emit("dispatch_clear")
        return {}


def build_hooks(dispatcher: Dispatcher):
    """-> hooks dict for ClaudeAgentOptions, or None if the SDK is too old."""
    try:
        from claude_agent_sdk import HookMatcher
    except Exception:
        return None
    return {
        "PreToolUse": [HookMatcher(hooks=[dispatcher.on_pre_tool])],
        "PostToolUse": [HookMatcher(matcher="Agent", hooks=[dispatcher.on_post_tool])],
        "SubagentStart": [HookMatcher(hooks=[dispatcher.on_subagent_start])],
        "SubagentStop": [HookMatcher(hooks=[dispatcher.on_subagent_stop])],
        "Stop": [HookMatcher(hooks=[dispatcher.on_stop])],
    }
