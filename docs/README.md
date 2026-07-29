# Meeting Copilot Documentation

## Quick Links

| Document | Description |
|----------|-------------|
| [CLAUDE.md](../CLAUDE.md) | Overview, status, commands |
| [CHANGELOG.md](../CHANGELOG.md) | Version history |

### Rule Files

| Document | Scope |
|----------|-------|
| [architecture.md](../.claude/rules/architecture.md) | Always loaded — system patterns, invariants |
| [gotchas.md](../.claude/rules/gotchas.md) | Always loaded — known issues |
| [swift-app.md](../.claude/rules/swift-app.md) | Path-scoped (`app/**`) — SwiftUI app patterns |
| [backend.md](../.claude/rules/backend.md) | Path-scoped (`server/**`) — Node.js server patterns |

### Reference Docs

| Document | Description |
|----------|-------------|
| [api.md](./api.md) | WebSocket & REST API reference |
| [setup.md](./setup.md) | Environment & deployment |
| [e2e-reliability-latency-plan.md](./e2e-reliability-latency-plan.md) | End-to-end performance, reliability, privacy, and model upgrade plan |

## Contributing

Run `/documenter` after development sessions to keep docs current.
