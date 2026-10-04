# Security policy

AgentMBX is alpha software. Security reports are welcome and are handled privately.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's private vulnerability reporting:

1. Open the repository's **Security** tab: <https://github.com/kryptobaseddev/agentmbx/security>.
2. Choose **Report a vulnerability** and fill in the advisory form.

This works only while private vulnerability reporting is enabled for the repository (Settings → Code security → Private vulnerability reporting). If the **Report a vulnerability** button is missing, open a public issue that asks for a private contact channel, and leave out every detail of the vulnerability.

Please do not report vulnerabilities in public issues, pull requests, discussions or AgentMBX messages.

## What to include

- the AgentMBX version (`agentmbx --version`) and the platform (macOS or Linux, Node version)
- the component: CLI, MCP server, daemon, LAN pairing or delivery, relay, owner key, identity leases, wake adapters, setup
- steps to reproduce, and what an attacker gains
- whether the issue needs a paired host, a same-user local process, a relay operator or a network position

## Scope

The trust boundaries are in [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) and [docs/SPEC.md](docs/SPEC.md). Some limits are documented and are not vulnerabilities by themselves:

- Processes running as the same OS user can read the local store and keys (D001).
- Envelope metadata (addresses, subject, thread, refs, tags, sizes, timing) is visible on the LAN and to a relay operator. Only bodies are sealed.
- Agent names are labels. A signature proves the sending host, not which agent on it wrote the message.

A way around any of these documented protections is in scope: signatures, body sealing, key pinning, owner grants, identity leases, wake limits, or the rule that message content never changes permissions.

## Supported versions

Fixes go into the latest release. Upgrade with the AgentMBX updater or a fresh install; older versions do not receive backports.
