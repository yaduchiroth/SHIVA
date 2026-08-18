"""Companion tools — how SHIVA builds and reshapes his own council by voice.

Boss never writes a prompt. He answers questions (see the companion-interview
skill) and these tools compose the companion file for him.
"""
import os
import re
import tempfile
from typing import Any

from claude_agent_sdk import tool

from . import companions as C
from .tools_mac import _CTX, _ok, _acting

_SLUG_BAD = re.compile(r"[^a-z0-9-]")


def _slugify(name: str) -> str:
    s = _SLUG_BAD.sub("-", (name or "").lower()).strip("-")
    return re.sub(r"-+", "-", s)[:24]


def _compose(name, role, trigger, color, model, groups, skills, knowledge,
             personality, guardrails, shape, orbit_i) -> str:
    fm = [
        "---",
        f"slug: {_slugify(name)}",
        f"name: {name}",
        f"role: {role}",
        f"trigger: {trigger}",
        f'color: "{color}"',
        f"model: {model or 'sonnet'}",
        f"groups: [{', '.join(groups)}]",
    ]
    if skills:
        fm.append(f"skills: [{', '.join(skills)}]")
    if knowledge:
        fm.append(f"knowledge: [{', '.join(knowledge)}]")
    fm += [
        "max_turns: 10",
        f"orbit: {{radius: {5.4 + (orbit_i % 5) * 0.7:.1f}, "
        f"incline: {(orbit_i * 23) % 60 - 30}, phase: {(orbit_i * 67) % 360}}}",
        "---",
        "",
        f"You are {name} — SHIVA's {role.lower()}.",
        "",
        "## How you work",
        personality.strip() or "- Do the work well and report tightly.",
        "",
        "## What you never do",
        guardrails.strip() or "- Never invent facts. Never act outside your remit.",
        "",
        "## Shape of your brief",
        shape.strip() or "The answer first, then only the detail that earns its place.",
    ]
    return "\n".join(fm) + "\n"


@tool("create_companion",
      "Summon a new companion onto SHIVA's council after interviewing Boss. "
      "personality/guardrails/shape are markdown bullet lists YOU compose from "
      "his answers — never ask him for a prompt. groups is a comma list from: "
      "web, hud, memory, mac, mail, files, business. trigger is a comma list of "
      "the kinds of request that should route to them.",
      {"name": str, "role": str, "trigger": str, "color": str, "model": str,
       "groups": str, "skills": str, "knowledge": str,
       "personality": str, "guardrails": str, "shape": str})
async def create_companion(args: dict[str, Any]) -> dict[str, Any]:
    await _acting("summoning a companion")
    name = (args.get("name") or "").strip()
    if not name:
        return _ok("I need a name for them.")
    slug = _slugify(name)
    if not C.SLUG_RE.match(slug):
        return _ok(f"'{name}' doesn't make a usable name.")
    existing = C.load()
    if len(existing) >= C.MAX_COMPANIONS:
        return _ok(f"The council is full at {C.MAX_COMPANIONS}.")
    if any(c.slug == slug for c in existing):
        return _ok(f"{name} is already on the Gana — update them instead.")

    def lst(k):
        return [x.strip() for x in (args.get(k) or "").split(",") if x.strip()]

    body = _compose(name, args.get("role") or "Specialist",
                    args.get("trigger") or "", args.get("color") or "#e8b93c",
                    args.get("model") or "sonnet", lst("groups") or ["hud", "memory"],
                    lst("skills"), lst("knowledge"),
                    args.get("personality") or "", args.get("guardrails") or "",
                    args.get("shape") or "", len(existing))
    C.COMPANIONS_DIR.mkdir(parents=True, exist_ok=True)
    path = C.COMPANIONS_DIR / f"{slug}.md"
    tmp = tempfile.NamedTemporaryFile("w", dir=str(C.COMPANIONS_DIR),
                                      suffix=".tmp", delete=False)
    try:
        tmp.write(body); tmp.flush(); os.fsync(tmp.fileno())
    finally:
        tmp.close()
    os.replace(tmp.name, path)
    bus = _CTX.get("bus")
    if bus:
        await bus.emit("roster_pending", slug=slug, name=name,
                       color=args.get("color") or "#e8b93c")
    return _ok(f"{name} is written and standing by as '{slug}'. Ask Boss for a "
               f"spoken yes, then call reload_council to bring them online.")


@tool("update_companion",
      "Reshape an existing companion. Give the slug and ONLY the sections that "
      "change (personality, guardrails, shape, trigger, color, model). This is "
      "a targeted edit — everything you don't pass is left alone.",
      {"slug": str, "personality": str, "guardrails": str, "shape": str,
       "trigger": str, "color": str, "model": str})
async def update_companion(args: dict[str, Any]) -> dict[str, Any]:
    await _acting("reshaping a companion")
    slug = _slugify(args.get("slug") or "")
    path = C.COMPANIONS_DIR / f"{slug}.md"
    if not path.exists():
        return _ok(f"No companion called '{slug}'.")
    text = path.read_text()
    changed = []
    for key in ("trigger", "color", "model"):
        val = (args.get(key) or "").strip()
        if val:
            quoted = f'"{val}"' if key == "color" else val
            if re.search(rf"(?m)^{key}:.*$", text):
                text = re.sub(rf"(?m)^{key}:.*$", f"{key}: {quoted}", text)
            changed.append(key)
    for key, header in (("personality", "## How you work"),
                        ("guardrails", "## What you never do"),
                        ("shape", "## Shape of your brief")):
        val = (args.get(key) or "").strip()
        if not val:
            continue
        pat = re.compile(rf"(?ms)^{re.escape(header)}\n.*?(?=^## |\Z)")
        block = f"{header}\n{val}\n\n"
        text = pat.sub(block, text) if pat.search(text) else text.rstrip() + "\n\n" + block
        changed.append(key)
    if not changed:
        return _ok("Nothing to change — tell me which part to reshape.")
    path.write_text(text)
    return _ok(f"Updated {slug}: {', '.join(changed)}. Call reload_council to "
               f"apply it.")


@tool("reload_council",
      "Bring roster changes live — reconnects SHIVA while keeping the current "
      "conversation. Call only after Boss says yes.", {})
async def reload_council(args: dict[str, Any]) -> dict[str, Any]:
    brain = _CTX.get("brain")
    if not brain:
        return _ok("I can't reach my own roster loader.")
    note = await brain.reload_companions()
    return _ok(note)


@tool("list_council",
      "List the current council: who they are, what they own, and what skills "
      "and reach they have.", {})
async def list_council(args: dict[str, Any]) -> dict[str, Any]:
    cs = C.load()
    if not cs:
        return _ok("The council is empty.")
    lines = [f"- {c.name} ({c.slug}) — {c.role}. Reach: "
             f"{', '.join(c.groups) or 'none'}. Skills: "
             f"{', '.join(c.skills) or 'none'}." for c in cs]
    skills = C.skill_summary()
    extra = ("\n\nSkills available to assign:\n"
             + "\n".join(f"- {s['name']}: {s['description'][:80]}" for s in skills)) if skills else ""
    return _ok("\n".join(lines) + extra)


COMPANION_TOOLS = [create_companion, update_companion, reload_council, list_council]
