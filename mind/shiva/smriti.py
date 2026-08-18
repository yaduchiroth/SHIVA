"""Smriti — SHIVA's memory. Durable JSON fact store.

Reads are mtime-checked so facts written by another process (a companion, the
Config View, a second SHIVA) show up without a relaunch, and the digest is fed
into every turn by the brain's context hook rather than frozen into the system
prompt at boot.
"""
import json
import os
import tempfile
import time


class Smriti:
    def __init__(self, cfg) -> None:
        self.path = cfg.memory_path
        self.facts: list[dict] = []
        self._mtime = 0.0
        self.reload()

    # ── persistence ────────────────────────────────────────────────────────
    def reload(self, force: bool = False) -> bool:
        """Re-read if the file changed underneath us. True if it did."""
        try:
            mtime = self.path.stat().st_mtime if self.path.exists() else 0.0
        except OSError:
            return False
        if not force and mtime == self._mtime:
            return False
        self._mtime = mtime
        if not self.path.exists():
            self.facts = []
            return True
        try:
            raw = json.loads(self.path.read_text())
            # tolerate both the old [{ts,fact}] shape and the pinned one
            self.facts = [f for f in raw if isinstance(f, dict) and f.get("fact")]
        except Exception:
            self.facts = []
        return True

    def _save(self) -> None:
        """Atomic write — parallel companions can call remember() at once."""
        tmp = tempfile.NamedTemporaryFile(
            "w", dir=str(self.path.parent), suffix=".tmp", delete=False)
        try:
            json.dump(self.facts, tmp, indent=2)
            tmp.flush()
            os.fsync(tmp.fileno())
        finally:
            tmp.close()
        os.replace(tmp.name, self.path)
        try:
            self._mtime = self.path.stat().st_mtime
        except OSError:
            pass

    # ── api ────────────────────────────────────────────────────────────────
    def remember(self, fact: str, pinned: bool = False) -> None:
        self.reload()  # don't clobber a sibling's write
        self.facts.append({"ts": time.time(), "fact": fact.strip(), "pinned": pinned})
        self._save()

    def recall(self, limit: int = 60) -> list[str]:
        """Pinned facts always survive; the rest is the most recent tail."""
        self.reload()
        pinned = [f["fact"] for f in self.facts if f.get("pinned")]
        rest = [f["fact"] for f in self.facts if not f.get("pinned")]
        room = max(0, limit - len(pinned))
        return pinned + rest[-room:]

    def as_prompt(self) -> str:
        facts = self.recall()
        if not facts:
            return "No stored memories yet."
        return "\n".join(f"- {f}" for f in facts)

    def digest(self, max_chars: int = 3000) -> str:
        """Bounded version for per-turn injection — newest facts win."""
        out, total = [], 0
        for line in reversed(self.as_prompt().splitlines()):
            if total + len(line) > max_chars:
                break
            out.append(line)
            total += len(line)
        return "\n".join(reversed(out))
