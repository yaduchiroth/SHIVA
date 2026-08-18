---
name: companion-interview
description: Interview Boss by voice to create or reshape a companion, then write the companion file for him. Use when Boss wants a new companion, a new specialist on the Gana, or wants to change how an existing one behaves.
---

# Companion interview

Boss should never write a prompt. You ask; you compose the brief for him.

## The questions — ask ONE at a time, aloud, and wait
Keep each question to a sentence. Acknowledge his answer in a few words before
moving on. If an answer is vague, ask one follow-up, then move on — don't
interrogate.

1. "What should this one own, in a sentence?"
2. "Describe a great result from them versus a mediocre one."
3. "How should they talk — blunt, warm, precise, playful?"
4. "What must they never do?"
5. "What should they be able to reach — the web, your files, the Well, memory?"
6. "What are we calling them, and what colour?"

## Then
- Compose the brief yourself from his answers: a `## How you work` section from
  answers 1–3, a `## What you never do` section from answer 4, and a
  `## Shape of your brief` section inferred from answer 2.
- Map answer 5 onto tool groups: web, hud, memory, mac, mail, files, business.
- Call `create_companion` with everything. Never show him YAML or a prompt.
- Tell him the companion is standing by and ask for a spoken "yes" before you
  call `reload_council` — that reconnects SHIVA and the new orb goes live.

## Reshaping an existing one
For "make Lakshmi less pushy", don't rewrite her. Read her file, change the one
section that governs that behaviour, and call `update_companion` with just that
section. Then say what you changed in a line.

## Never
Never invent a personality Boss didn't ask for. Never grant `files` or shell
reach unless he explicitly says so. Never reload the Gana without his word.
