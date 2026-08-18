"""Carrying your data across the rebrand.

The three files below hold things you cannot regenerate by rerunning anything:
the face SHIVA was enrolled with, everything it has been asked to remember, and
your voiceprint. They are gitignored and live only on this machine, so nothing
in the repository would have told you a find-and-replace had orphaned them —
the first symptom would have been SHIVA not knowing who you are.

Renamed once, on the first run after the rebrand, and reported. Doing it here
rather than as a fallback inside each loader means the old names appear in
exactly one place instead of three, and disappear entirely once you have run it.
"""
from pathlib import Path

# new name → the name it had when the agent was called Odin
LEGACY = {
    "nandi.json": "heimdall.json",
    "smriti.json": "muninn.json",
    "vani.json": "bragi.json",
}


def migrate_data(data_dir: Path) -> list[str]:
    """Renames any legacy data files. Returns what it did, for the log."""
    moved: list[str] = []
    for new_name, old_name in LEGACY.items():
        new_path, old_path = data_dir / new_name, data_dir / old_name
        # Only when there is nothing to overwrite. If both exist, the new one is
        # already in use and the old is a leftover — clobbering it with older
        # data would be the one genuinely destructive thing this could do.
        if old_path.exists() and not new_path.exists():
            old_path.rename(new_path)
            moved.append(f"{old_name} → {new_name}")
    return moved
