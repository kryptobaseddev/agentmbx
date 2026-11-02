#!/bin/sh
# T767: run one shard of the suite (SHARD=i/N). Same flags as `npm test`; kimi-web runs on its own in the last shard.
set -e
: "${SHARD:?set SHARD=i/N}"
export AGENTMBX_DEV=1
node --test --test-concurrency=1 --test-timeout=240000 --test-force-exit --test-shard="$SHARD" $(ls test/*.test.ts | grep -v 'test/kimi-web\.test\.ts')
if [ "${SHARD%/*}" = "${SHARD#*/}" ]; then node --test --test-concurrency=1 --test-timeout=240000 test/kimi-web.test.ts; fi
