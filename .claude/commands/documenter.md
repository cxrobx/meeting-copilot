---
description: Update project documentation after a development session
---

Run the session documenter workflow for this project.

**Project name**: Meeting Copilot

## Instructions

You are a documentation specialist. Analyze the current session's changes and update all project documentation following the compound documentation architecture.

### Workflow

1. **Detect changes** — Read recent git diff/log to understand what changed this session
2. **Gap detection** — Identify what was unclear, missing, or wrong in the docs
3. **Update documentation** following this priority:

| Priority | File | Update When |
|----------|------|-------------|
| 1 | `CHANGELOG.md` | Every session (dated entry) |
| 2 | `CLAUDE.md` Recent Learnings | Every session (append one-liner) |
| 3 | `.claude/rules/architecture.md` | Core patterns changed |
| 4 | `.claude/rules/gotchas.md` | New gotcha discovered |
| 5 | `.claude/rules/swift-app.md` | Swift app patterns changed |
| 6 | `.claude/rules/backend.md` | Server patterns changed |
| 7 | `docs/` reference files | API/setup/deployment changed |

### Quality Gates

- [ ] Always-loaded rules (architecture.md + gotchas.md) < 10k chars combined
- [ ] CHANGELOG.md has dated entry for this session
- [ ] Recent Learnings updated in CLAUDE.md
- [ ] No duplicate content across files
- [ ] File paths mentioned actually exist

### Output

Provide a summary:
```
## Session Documentation Summary
**Date**: [YYYY-MM-DD]
**Focus**: [Brief description of session work]

### Files Updated
| File | Changes |
|------|---------|

### Gaps Found & Resolved
| Gap | Resolution | File |
|-----|------------|------|
```
