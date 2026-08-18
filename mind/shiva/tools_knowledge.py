"""Knowledge tools — how SHIVA and his companions read and grow the corpus."""
from typing import Any

from claude_agent_sdk import tool

from .tools_mac import _CTX, _ok, _acting


def _kb():
    return _CTX.get("knowledge")


@tool("knowledge_search",
      "Search the knowledge base — everything the team is supposed to already "
      "know about Boss, the business, clients and standing decisions. Use this "
      "BEFORE answering anything about our own context, positioning, pricing, "
      "people or history. Returns the most relevant passages.",
      {"query": str, "k": int})
async def knowledge_search(args: dict[str, Any]) -> dict[str, Any]:
    kb = _kb()
    if not kb:
        return _ok("Knowledge base unavailable.")
    hits = kb.search(args.get("query") or "", int(args.get("k") or 5))
    if not hits:
        return _ok("Nothing in the knowledge base matches that. Say so rather "
                   "than guessing, or ask Boss to add it.")
    bus = _CTX.get("bus")
    if bus:
        await bus.emit("knowledge", action="search",
                       slugs=[h["slug"] for h in hits])
    return _ok("\n\n".join(
        f"[{h['slug']}] {h['title']}" + (f" › {h['head']}" if h["head"] else "")
        + f"\n{h['text']}" for h in hits))


@tool("knowledge_read", "Read a whole knowledge-base document by its slug.",
      {"slug": str})
async def knowledge_read(args: dict[str, Any]) -> dict[str, Any]:
    kb = _kb()
    if not kb:
        return _ok("Knowledge base unavailable.")
    body = kb.read((args.get("slug") or "").strip())
    return _ok(body or f"No document named {args.get('slug')!r}.")


@tool("knowledge_write",
      "Add or replace a knowledge-base document — this is how the team's "
      "context compounds. Use when Boss states a durable fact about the "
      "business, a decision, a client's preferences, or when a companion "
      "produces research worth keeping. Set always=true only for things every "
      "companion must always have in mind (keep those short).",
      {"title": str, "body": str, "tags": str, "always": str})
async def knowledge_write(args: dict[str, Any]) -> dict[str, Any]:
    kb = _kb()
    if not kb:
        return _ok("Knowledge base unavailable.")
    await _acting("knowledge write")
    tags = [t.strip() for t in (args.get("tags") or "").split(",") if t.strip()]
    always = str(args.get("always", "")).lower() in ("1", "true", "yes")
    slug = kb.write(args.get("title") or "Note", args.get("body") or "", tags, always)
    bus = _CTX.get("bus")
    if bus:
        await bus.emit("knowledge", action="write", slugs=[slug])
    return _ok(f"Filed as '{slug}' in the knowledge base.")


@tool("knowledge_list", "List every document in the knowledge base.", {})
async def knowledge_list(args: dict[str, Any]) -> dict[str, Any]:
    kb = _kb()
    if not kb:
        return _ok("Knowledge base unavailable.")
    kb.reload()
    if not kb.docs:
        return _ok("The knowledge base is empty.")
    return _ok("\n".join(
        f"- {d.slug}: {d.title}" + (" (always-on)" if d.always else "")
        for d in kb.docs))


KNOWLEDGE_TOOLS = [knowledge_search, knowledge_read, knowledge_write, knowledge_list]
