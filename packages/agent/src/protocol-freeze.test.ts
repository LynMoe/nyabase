import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_PROTOCOL_VERSION } from '@nyabase/common';

/*
 * A Backend and an agent of different builds talk only when they speak the
 * same AGENT_PROTOCOL_VERSION, and that version promises both the frame
 * shapes and what the policy accepts. So any edit to these files is a
 * decision: if a Backend built from the other side of the edit could send
 * something this agent refuses (or the reverse), bump AGENT_PROTOCOL_VERSION
 * and document the upgrade in deploy/OPERATIONS.md; either way, re-pin.
 */
const CONTRACT_SOURCES = [
  '../../common/src/protocol/agent.ts',
  'policy.ts',
  'policy-body.ts',
] as const;

const PINNED: { readonly protocol: number; readonly sha256: string } = {
  protocol: 2,
  sha256: 'f44cffab31543ad7fcb4e86957f21bbc82cec4d0b2944bdfe4137461f0cd45bd',
};

function contractDigest(): string {
  const hash = createHash('sha256');
  for (const source of CONTRACT_SOURCES) {
    hash.update(`${source}\n`);
    hash.update(readFileSync(join(__dirname, source)));
  }
  return hash.digest('hex');
}

const REPIN_HELP = [
  'The agent protocol contract changed (common/src/protocol/agent.ts, agent policy.ts or policy-body.ts).',
  'Decide whether a Backend and an agent built on different sides of this change could refuse each',
  "other's frames or requests. If so, bump AGENT_PROTOCOL_VERSION (common/src/protocol/agent.ts) and",
  'write the upgrade order in deploy/OPERATIONS.md ("升级与版本匹配"); if not (or the current version',
  'never shipped), keep it. Either way, copy the received protocol and sha256 into PINNED in',
  'packages/agent/src/protocol-freeze.test.ts. REST-only types do not belong in agent.ts.',
].join('\n');

describe('agent protocol contract', () => {
  it('is pinned for the current protocol version', () => {
    expect({ protocol: AGENT_PROTOCOL_VERSION, sha256: contractDigest() }, REPIN_HELP).toEqual(PINNED);
  });
});
