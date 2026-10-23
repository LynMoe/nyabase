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
  sha256: '143e7aa0d30a23c0a5f9d8cc16cba894ca16416674a9c2b0df0336ef60f9bf7b',
};

function contractDigest(): string {
  const hash = createHash('sha256');
  for (const source of CONTRACT_SOURCES) {
    hash.update(`${source}\n`);
    hash.update(readFileSync(join(__dirname, source)));
  }
  return hash.digest('hex');
}

describe('agent protocol contract', () => {
  it('is pinned for the current protocol version', () => {
    expect({ protocol: AGENT_PROTOCOL_VERSION, sha256: contractDigest() }).toEqual(PINNED);
  });
});
