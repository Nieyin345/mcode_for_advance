# Issue Tracker: Local Markdown

## Primary tracker

Engineering Skill specifications and planning tickets are stored as local Markdown files in `.scratch/`.

GitHub Issues are not the default tracker for these skills, even if the repository has a Git remote.

## Directory conventions

Each engineering effort has its own directory:

```text
.scratch/<feature-slug>/
├── spec.md
├── map.md
└── issues/
    ├── 01-<slug>.md
    ├── 02-<slug>.md
    └── ...
```

- `spec.md`: approved problem statement, intended behavior, scope, and testing decisions.
- `map.md`: optional Wayfinder planning map containing decisions, dependencies, unresolved questions, and out-of-scope items.
- `issues/NN-<slug>.md`: one ticket per file, numbered from `01` in dependency order.
- `Blocked by`: references the numbered tickets that must resolve before this ticket can start.
- `## Comments`: append relevant follow-up discussion without overwriting prior history.

## Triage conventions

Use these five state values:

- `needs-triage`
- `needs-info`
- `ready-for-agent`
- `ready-for-human`
- `wontfix`

Implementation and planning tickets should also record a category when triaged:

- `Category: bug`
- `Category: enhancement`

For ordinary implementation tickets, `Status:` records the Triage state.
For Wayfinder decision tickets, `Type:` records the ticket type and
`Status:` records `claimed` or `resolved`, as required by the Wayfinder skill.

Do not confuse a planning decision being resolved with an implementation
task being completed and accepted.

## Relationship with Mcode execution tasks

The existing `tasks/` directory remains authoritative for formal Mcode
execution cards and their acceptance evidence.

- Existing T-numbered tasks remain in `tasks/`; never migrate or renumber them.
- Use `.scratch/` when the engineering skills need a feature specification,
  exploratory questions, or a dependency graph.
- When an approved planning ticket must be delegated to an independent Mcode
  execution conversation, create or update the corresponding `tasks/Txx-*.md`
  card according to the existing Mcode task workflow.
- Link the planning spec/ticket path from the execution card.
- Do not duplicate the entire specification in the execution card. Include
  only the context required to execute the bounded task.
- The T task card is authoritative for writable file boundaries, acceptance
  criteria, required tests, commit requirements, and result writeback.
- The `.scratch/` spec and map are authoritative for the broader goal,
  planning decisions, and dependency relationships.

## Required Skills in new T task cards

- Every newly created T-numbered execution card must include a `## Required Skills` section.
- List exact skill names and a short explanation of when and why each skill applies.
- Select only skills relevant to the task; do not list every installed skill by default.
- Tell the execution agent to read the listed skill's `SKILL.md` before applying its workflow.
- Do not retrofit existing task cards unless explicitly requested.

If a planning ticket and a T task disagree about execution scope, stop and
reconcile the conflict before modifying code. Do not silently broaden a task.

## Publishing

When an engineering skill says "publish to the issue tracker", write to
`.scratch/<feature-slug>/` following the conventions above.

Never publish to GitHub or another external tracker unless the user
explicitly changes this configuration.
