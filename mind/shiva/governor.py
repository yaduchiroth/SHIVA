"""The Governor — a hand on the Gana's throttle.

Five companions with web search can burn a multiple of a normal session in a
single sentence, and subagent context is never cached against the parent. This
caps how many run at once and how much a single turn may spend.

Enforcement is a PreToolUse hook on the Agent tool returning a deny decision —
`can_use_tool` is silently shadowed under permission_mode="bypassPermissions"
(the SDK's own docs say to use a hook instead). The denial carries a reason the
model can act on, so SHIVA degrades to doing the work himself rather than failing.
"""
import time


class Governor:
    def __init__(self, cfg, bus, dispatcher) -> None:
        self.cfg = cfg
        self.bus = bus
        self.dispatcher = dispatcher
        self.max_parallel = int(getattr(cfg, "max_parallel_dispatch", 2))
        self.max_per_turn = int(getattr(cfg, "max_dispatch_per_turn", 4))
        self.turn_count = 0
        self._turn_started = time.time()

    def new_turn(self) -> None:
        self.turn_count = 0
        self._turn_started = time.time()

    async def gate_agent(self, input_data, tool_use_id, context):
        """PreToolUse[Agent] — allow ({}), or deny with a reason."""
        if (input_data or {}).get("tool_name") != "Agent":
            return {}
        live = self.dispatcher.live()
        if live >= self.max_parallel:
            return self._deny(
                f"{live} companions are already working. Wait for one to report "
                f"back before dispatching another, or handle this yourself.")
        if self.turn_count >= self.max_per_turn:
            return self._deny(
                f"That's {self.turn_count} dispatches this turn — the Gana's "
                f"budget for one request. Handle the rest yourself or ask Boss "
                f"to split the job.")
        self.turn_count += 1
        return {}

    def _deny(self, reason: str) -> dict:
        return {"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason}}
