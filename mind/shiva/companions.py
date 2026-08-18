"""The Gana — SHIVA's companions.

Each companion is a markdown file in companions/: frontmatter defines who they
are (role, colour, model, tools, skills, orbit), the body is their standing
brief. They're loaded into ClaudeAgentOptions.agents as AgentDefinitions, which
is what lets SHIVA dispatch to them by name — and run several at once.

Companions report to SHIVA, never to the user: SHIVA voices the headline. That
contract is appended to every brief so it can't be forgotten.
"""
import re
from dataclasses import dataclass, field
from pathlib import Path

from .config import ROOT

COMPANIONS_DIR = ROOT / "companions"
MAX_COMPANIONS = 20
SLUG_RE = re.compile(r"^[a-z][a-z0-9-]{1,23}$")

# Tool groups — the Config View offers these instead of raw tool names.
TOOL_GROUPS = {
    "web": ["WebSearch", "WebFetch"],
    "hud": ["mcp__shiva__hud_display", "mcp__shiva__hud_report",
            "mcp__shiva__hud_chart", "mcp__shiva__hud_web"],
    "memory": ["mcp__shiva__remember", "mcp__shiva__recall_memories"],
    "mac": ["mcp__shiva__run_applescript", "mcp__shiva__open_app",
            "mcp__shiva__calendar_today"],
    "mail": ["mcp__shiva__draft_email"],
    "files": ["Read", "Glob", "Grep"],          # read-only by default
    "business": ["mcp__shiva__company_kpis", "mcp__shiva__pending_approvals",
                 "mcp__shiva__inbox_triage"],
}

REPORTING_CONTRACT = """

## How you report
You are reporting to SHIVA, not to the user — SHIVA speaks to Boss himself.
Return a tight written brief: the answer first, then only the detail that
earns its place. No preamble, no sign-off, no "I hope this helps". If you put
something on the HUD, say so in one line. If you could not do it, say that
plainly and why. SHIVA will voice the headline in a sentence or two, so give
him a headline worth voicing."""


@dataclass
class Companion:
    slug: str
    name: str
    role: str
    color: str = "#e8b93c"
    model: str = "sonnet"
    enabled: bool = True
    prompt: str = ""
    tools: list[str] = field(default_factory=list)
    groups: list[str] = field(default_factory=list)
    skills: list[str] = field(default_factory=list)
    knowledge: list[str] = field(default_factory=list)
    max_turns: int = 10
    orbit: dict = field(default_factory=dict)

    def tool_list(self) -> list[str]:
        out: list[str] = []
        for g in self.groups:
            out += TOOL_GROUPS.get(g.strip().lower(), [])
        out += self.tools
        return sorted(set(out))

    def describe(self) -> str:
        """What SHIVA reads when choosing whom to dispatch — a routing trigger,
        not a bio."""
        return f"{self.name} — {self.role}. Use for: {self.trigger}"

    @property
    def trigger(self) -> str:
        return self._trigger or f"{self.role.lower()} work"

    _trigger: str = ""


# ── tiny frontmatter parser (PyYAML if available, else a strict subset) ─────
def _parse_scalar(v: str):
    v = v.strip()
    if not v:
        return ""
    if v[0] in "\"'" and v[-1] == v[0] and len(v) > 1:
        return v[1:-1]
    low = v.lower()
    if low in ("true", "yes"):
        return True
    if low in ("false", "no"):
        return False
    if v.startswith("[") and v.endswith("]"):
        return [_parse_scalar(x) for x in v[1:-1].split(",") if x.strip()]
    if v.startswith("{") and v.endswith("}"):
        out = {}
        for part in v[1:-1].split(","):
            if ":" in part:
                k, val = part.split(":", 1)
                out[k.strip()] = _parse_scalar(val)
        return out
    try:
        return int(v)
    except ValueError:
        pass
    try:
        return float(v)
    except ValueError:
        return v


def parse_frontmatter(text: str) -> tuple[dict, str]:
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    raw, body = text[3:end], text[end + 4:]
    try:
        import yaml  # optional
        meta = yaml.safe_load(raw) or {}
        if isinstance(meta, dict):
            return meta, body.lstrip("\n")
    except Exception:
        pass
    meta: dict = {}
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        k, v = line.split(":", 1)
        meta[k.strip()] = _parse_scalar(v)
    return meta, body.lstrip("\n")


def parse(path: Path) -> Companion | None:
    try:
        meta, body = parse_frontmatter(path.read_text())
    except OSError:
        return None
    slug = str(meta.get("slug") or path.stem).strip().lower()
    if not SLUG_RE.match(slug):
        return None
    c = Companion(
        slug=slug,
        name=str(meta.get("name") or slug.title()),
        role=str(meta.get("role") or "Specialist"),
        color=str(meta.get("color") or "#e8b93c"),
        model=str(meta.get("model") or "sonnet"),
        enabled=bool(meta.get("enabled", True)),
        prompt=body.strip(),
        tools=[str(t) for t in (meta.get("tools") or [])],
        groups=[str(g) for g in (meta.get("groups") or [])],
        skills=[str(s) for s in (meta.get("skills") or [])],
        knowledge=[str(k) for k in (meta.get("knowledge") or [])],
        max_turns=int(meta.get("max_turns") or 10),
        orbit=meta.get("orbit") or {},
    )
    c._trigger = str(meta.get("trigger") or "")
    return c


def load(directory: Path | None = None) -> list[Companion]:
    d = directory or COMPANIONS_DIR
    if not d.exists():
        return []
    out = []
    for p in sorted(d.glob("*.md")):
        if p.name.startswith("."):
            continue
        c = parse(p)
        if c and c.enabled:
            out.append(c)
    return out[:MAX_COMPANIONS]


def to_agents(companions: list[Companion]) -> dict:
    """-> {slug: AgentDefinition} for ClaudeAgentOptions.agents"""
    from claude_agent_sdk import AgentDefinition

    agents = {}
    for c in companions:
        kwargs = dict(
            description=c.describe(),
            prompt=c.prompt + REPORTING_CONTRACT,
            model=c.model,
            maxTurns=c.max_turns,
            # Synchronous: the turn waits for the Gana, so their findings
            # always come home to Boss in the same breath. (Async dispatch
            # returns instantly but strands results until the next utterance.)
            background=False,
        )
        tools = c.tool_list()
        if tools:
            kwargs["tools"] = tools
        if c.skills:
            kwargs["skills"] = c.skills
        agents[c.slug] = AgentDefinition(**kwargs)
    return agents


SKILLS_DIR = ROOT / ".claude" / "skills"


def available_skills() -> list[str]:
    """Skill slugs discoverable in .claude/skills/<slug>/SKILL.md.

    Named explicitly rather than "all" so SHIVA loads only his own library and
    not every plugin skill installed on this Mac.
    """
    if not SKILLS_DIR.exists():
        return []
    return sorted(p.parent.name for p in SKILLS_DIR.glob("*/SKILL.md"))


def skill_summary() -> list[dict]:
    """[{name, description}] read from each skill's frontmatter."""
    out = []
    for p in sorted(SKILLS_DIR.glob("*/SKILL.md")) if SKILLS_DIR.exists() else []:
        try:
            meta, _ = parse_frontmatter(p.read_text())
        except OSError:
            continue
        out.append({"name": str(meta.get("name") or p.parent.name),
                    "description": str(meta.get("description") or "")})
    return out


def roster_block(companions: list[Companion]) -> str:
    """The delegation briefing injected into SHIVA's system prompt."""
    if not companions:
        return ""
    lines = [f"- **{c.slug}** ({c.name}, {c.role}) — {c.trigger}" for c in companions]
    return (
        "\n\nYOUR COUNCIL — you have specialists. Dispatch with the Agent tool "
        "(subagent_type = the slug below), and dispatch SEVERAL AT ONCE when a "
        "request has separable parts:\n" + "\n".join(lines) + """

DELEGATION RULES (important — you are a chief of staff, not a doer):
- Anything needing research, drafting longer than a sentence, multi-step work,
  or more than about two tool calls goes to a companion. You route; they work.
- Handle yourself ONLY: Mac control, memory, the HUD, reminders, device/IoT
  commands, and one-line factual answers you already know.
- Say who you're putting on it in a few words BEFORE the work runs ("Brihaspati's
  on it"), so Boss isn't left in silence.
- When they report back, give Boss the headline in one or two sentences and put
  the detail on the Well. Never read a companion's full report aloud.
- If a companion fails or comes back thin, say so plainly — don't paper over it."""
    )
