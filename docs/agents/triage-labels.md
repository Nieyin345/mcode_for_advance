# Triage Labels

The engineering skills use five canonical state roles.
This repository uses the same strings for its local Markdown tracker.

| Canonical role | Local value | Meaning |
|---|---|---|
| `needs-triage` | `needs-triage` | Maintainer needs to evaluate the issue |
| `needs-info` | `needs-info` | Waiting for additional information |
| `ready-for-agent` | `ready-for-agent` | Fully specified and ready for agent execution |
| `ready-for-human` | `ready-for-human` | Requires human implementation or judgment |
| `wontfix` | `wontfix` | Will not be actioned |

When triaging an issue, record exactly one state role and one category:
`bug` or `enhancement`.

Use the `Category:` field for the category and `Status:` for the Triage
state on ordinary implementation tickets.

Wayfinder decision tickets use their own `Type:` and `Status:` conventions
as specified in `docs/agents/issue-tracker.md`.

Do not treat `ready-for-agent` as proof that an implementation has passed
tests or acceptance. It only means the ticket is sufficiently specified
to begin.
