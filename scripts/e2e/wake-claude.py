#!/usr/bin/env python3
"""Fail-closed entry point for the retired unattended native wake harness.

The previous implementation automated provider approvals and destroyed its PTY.
Do not restore it without owner-controlled prompts, retained sessions, checked
command results, and current lease-aware sender/session setup (T105/T083).
This entry point deliberately starts no provider and touches no configuration.
"""
import json
import sys

print(json.dumps({
    "provider": "claude",
    "outcome": "blocked_harness_unsupported",
    "reason": "Owner-controlled prompts and resumable lease-aware validation are not implemented (T105).",
    "provider_started": False,
    "receipt_verified": False,
}))
sys.exit(3)
