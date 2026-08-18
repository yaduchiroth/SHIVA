"""The Knowledge Base — what the Gana always knows.

Markdown documents in knowledge/. Retrieval is three tiers, cheapest first:

  1. INDEX      every doc's title/tags/summary is injected each turn, so the
                model always knows what exists and can ask for it by name.
  2. ALWAYS-ON  docs marked `always: true` are inlined verbatim (budgeted).
  3. SEARCH     knowledge_search runs BM25 over paragraph chunks.

BM25 rather than embeddings: zero dependencies, rebuilt in milliseconds,
debuggable, and on a curated hand-written corpus it beats naive vector search.
A Retriever seam is left for an MLX-embedding backend later.
"""
import math
import os
import re
import tempfile
import time
from collections import Counter
from pathlib import Path

from .config import ROOT
from .companions import parse_frontmatter

KNOWLEDGE_DIR = ROOT / "knowledge"
CHUNK_CHARS = 800
OVERLAP = 100
ALWAYS_BUDGET = 6000
_WORD = re.compile(r"[a-z0-9']+")


def _tok(s: str) -> list[str]:
    return _WORD.findall(s.lower())


class Doc:
    def __init__(self, path: Path):
        meta, body = parse_frontmatter(path.read_text())
        self.path = path
        self.slug = path.stem
        self.title = str(meta.get("title") or self.slug.replace("-", " ").title())
        self.tags = [str(t) for t in (meta.get("tags") or [])]
        self.companions = [str(c) for c in (meta.get("companions") or ["all"])]
        self.always = bool(meta.get("always", False))
        self.updated = str(meta.get("updated") or "")
        self.body = body.strip()
        self.mtime = path.stat().st_mtime

    def summary(self) -> str:
        for line in self.body.splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                return line[:140]
        return ""

    def chunks(self) -> list[tuple[str, str]]:
        """-> [(heading, text)] — paragraph windows tagged with their section.

        Headings are peeled off line-by-line, never block-by-block: a heading
        followed immediately by its prose is one block in markdown, and treating
        the whole block as a heading would silently swallow the content.
        """
        out, head, buf = [], "", ""

        def flush(force: bool) -> None:
            nonlocal buf
            while len(buf) >= CHUNK_CHARS:
                out.append((head, buf[:CHUNK_CHARS]))
                buf = buf[CHUNK_CHARS - OVERLAP:]
            if force and buf.strip():
                out.append((head, buf.strip()))
                buf = ""

        for line in self.body.splitlines():
            s = line.strip()
            if s.startswith("#"):
                flush(True)                     # close the previous section
                head = s.lstrip("# ").strip()
                continue
            buf += line + "\n"
            flush(False)
        flush(True)
        return out


class Knowledge:
    def __init__(self, directory: Path | None = None):
        self.dir = directory or KNOWLEDGE_DIR
        self.docs: list[Doc] = []
        self.chunks: list[dict] = []
        self._df: Counter = Counter()
        self._avg_len = 1.0
        self._stamp = 0.0
        self.reload()

    # ── index ──────────────────────────────────────────────────────────────
    def _fingerprint(self) -> float:
        if not self.dir.exists():
            return 0.0
        return sum(p.stat().st_mtime for p in self.dir.glob("*.md"))

    def reload(self, force: bool = False) -> bool:
        fp = self._fingerprint()
        if not force and fp == self._stamp:
            return False
        self._stamp = fp
        self.docs = []
        if self.dir.exists():
            for p in sorted(self.dir.glob("*.md")):
                if p.name.startswith("."):
                    continue
                try:
                    self.docs.append(Doc(p))
                except Exception:
                    continue
        self.chunks = []
        self._df = Counter()
        total = 0
        for d in self.docs:
            for head, text in d.chunks():
                toks = _tok(text)
                if not toks:
                    continue
                tf = Counter(toks)
                self.chunks.append({"slug": d.slug, "title": d.title, "head": head,
                                    "text": text, "tf": tf, "len": len(toks)})
                total += len(toks)
                for w in tf:
                    self._df[w] += 1
        self._avg_len = (total / len(self.chunks)) if self.chunks else 1.0
        return True

    # ── retrieval ──────────────────────────────────────────────────────────
    def search(self, query: str, k: int = 5) -> list[dict]:
        """Okapi BM25 over chunks."""
        self.reload()
        q = _tok(query)
        if not q or not self.chunks:
            return []
        N = len(self.chunks)
        k1, b = 1.5, 0.75
        scored = []
        for c in self.chunks:
            s = 0.0
            for w in q:
                f = c["tf"].get(w, 0)
                if not f:
                    continue
                idf = math.log(1 + (N - self._df[w] + 0.5) / (self._df[w] + 0.5))
                s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * c["len"] / self._avg_len))
            if s > 0:
                scored.append((s, c))
        scored.sort(key=lambda x: -x[0])
        return [{"slug": c["slug"], "title": c["title"], "head": c["head"],
                 "text": c["text"], "score": round(s, 2)} for s, c in scored[:k]]

    def read(self, slug: str) -> str | None:
        self.reload()
        for d in self.docs:
            if d.slug == slug:
                return d.body
        return None

    def index_block(self) -> str:
        """The table of contents injected every turn — cheap, and it teaches the
        model exactly what it can ask for."""
        self.reload()
        if not self.docs:
            return ""
        lines = [f"- {d.slug} — {d.title}"
                 + (f" [{', '.join(d.tags)}]" if d.tags else "")
                 + (f": {d.summary()}" if d.summary() else "")
                 for d in self.docs]
        return ("Knowledge base (use knowledge_search or knowledge_read by slug):\n"
                + "\n".join(lines))

    def always_block(self, companion: str | None = None) -> str:
        """Docs marked always:true, inlined under a hard character budget."""
        self.reload()
        out, total = [], 0
        for d in sorted(self.docs, key=lambda d: d.updated, reverse=True):
            if not d.always:
                continue
            if companion and "all" not in d.companions and companion not in d.companions:
                continue
            piece = f"### {d.title}\n{d.body}"
            if total + len(piece) > ALWAYS_BUDGET:
                break
            out.append(piece)
            total += len(piece)
        return "\n\n".join(out)

    # ── writing (this is what makes it compound) ───────────────────────────
    def write(self, title: str, body: str, tags: list[str] | None = None,
              always: bool = False) -> str:
        self.dir.mkdir(parents=True, exist_ok=True)
        slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:40] or "note"
        path = self.dir / f"{slug}.md"
        fm = (f"---\ntitle: {title}\ntags: [{', '.join(tags or [])}]\n"
              f"companions: [all]\nalways: {'true' if always else 'false'}\n"
              f"updated: {time.strftime('%Y-%m-%d')}\n---\n\n")
        tmp = tempfile.NamedTemporaryFile("w", dir=str(self.dir), suffix=".tmp", delete=False)
        try:
            tmp.write(fm + body.strip() + "\n")
            tmp.flush()
            os.fsync(tmp.fileno())
        finally:
            tmp.close()
        os.replace(tmp.name, path)
        self.reload(force=True)
        return slug
