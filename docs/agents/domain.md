# Domain Docs

## Layout

This repository uses a single-context domain documentation layout:

- `GLOSSARY.md`: canonical domain terminology at the repository root.
- `docs/adr/`: architecture decision records at the repository root.

Do not create `GLOSSARY-MAP.md` or per-package glossary files unless the
project explicitly adopts a multi-context layout in the future.

## Before exploring or changing code

1. Read `GLOSSARY.md` if it exists.
2. Read relevant ADRs under `docs/adr/` if that directory exists.
3. Read `AGENTS.md`, `CLAUDE.md`, and relevant subsystem documentation
   when the task requires their guidance.
4. If the glossary or ADR directory does not yet exist, proceed using the
   available project documentation. Do not invent missing decisions or
   block unrelated work on documentation setup.

## Vocabulary

Use canonical terms from `GLOSSARY.md` in specifications, task titles,
test names, and architecture discussions.

If a term is genuinely unresolved, call out the gap rather than silently
introducing a competing name.

## Architecture decisions

When a change establishes or revises an architectural decision, determine
whether an ADR is warranted. Record the rationale, alternatives, and
consequences when the decision is durable and cross-cutting.

If a proposal conflicts with an existing ADR, explicitly identify the
conflict and seek resolution rather than silently overriding it.

## Scope

This document describes where domain knowledge belongs and how engineering
skills consume it. It does not authorize broad refactors or require every
small task to create a glossary entry or ADR.
