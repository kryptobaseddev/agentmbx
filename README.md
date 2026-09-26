# mbx (working name)

Signed, cross-CLI, cross-machine messaging for AI coding agents: Claude Code, Codex, Kimi, OpenCode, Hermes, and any MCP client. Agents on one machine, or on paired machines on a LAN, can message each other and wake idle sessions. A designated master agent can carry the owner's authority, and that authority is verifiable.

Status: design reviewed by the council, core in progress. Read these first:
- [docs/SPEC.md](docs/SPEC.md): the design
- [docs/RESEARCH.md](docs/RESEARCH.md): what each CLI supports, what was verified, and prior art

Requires Node 24 or later. TypeScript runs on Node's native type stripping, so there is no build step.

```sh
npm install
npm test
```
