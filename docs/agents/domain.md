# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md` at the repo root.** It exists and holds this repo's glossary: launch context,
  trust path, tenant boundary, and the other terms the authorization layer depends on, each with
  the synonyms to avoid. Read it before naming anything.
- **`docs/adr/`**: read the ADRs that touch the area you're about to work in. They are decisions
  rather than suggestions, and they are numbered by topic — read the ones whose titles match your
  change. ADR-0002 in particular decides that the launch context will **not** live in the access
  token; ADR-0001 that the gateway signs nothing.

This is a single-context repo, so there is no `CONTEXT-MAP.md`. If a future area introduces one,
update this file when you do.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding.