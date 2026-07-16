import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const AGENT_SHUTDOWN_CONTRACT = [
  'KillMode=control-group',
  'TimeoutStopSec=30s',
  'SendSIGKILL=yes',
  'StateDirectory=nyabase-agent',
  'StateDirectoryMode=0700',
] as const;

describe('Agent systemd shutdown contract', () => {
  const repoRoot = fs.existsSync(path.resolve(process.cwd(), 'deploy/agent.systemd.service'))
    ? process.cwd()
    : path.resolve(process.cwd(), '../..');

  it.each([
    ['production unit', 'deploy/agent.systemd.service'],
    ['live-test unit template', 'test/scripts/deploy-agents.sh'],
  ])('enforces the child-process cleanup contract in %s', (_label, relativePath) => {
    const content = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
    for (const directive of AGENT_SHUTDOWN_CONTRACT) {
      expect(content).toContain(directive);
    }
  });
});
