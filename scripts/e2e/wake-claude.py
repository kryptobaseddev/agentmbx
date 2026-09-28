#!/usr/bin/env python3
"""Prepare an owner-operated session; unattended native launch remains disabled."""
from pathlib import Path
import runpy
import sys

root = Path(__file__).resolve().parents[2]
entry = runpy.run_path(str(root / 'scripts/e2e/prepare_terminal.py'))['entry']
sys.exit(entry('claude', root))
