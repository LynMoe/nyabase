import { Injectable } from '@nestjs/common';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface GeneratedSshKeyPair {
  privateKey: string;
  publicKey: string;
  fingerprint: string;
}

@Injectable()
export class SshKeygenService {
  async generateEd25519(comment: string): Promise<GeneratedSshKeyPair> {
    const dir = await mkdtemp(join(tmpdir(), 'nyabase-ssh-key-'));
    const keyPath = join(dir, 'id_ed25519');
    try {
      await execFileAsync('ssh-keygen', [
        '-q',
        '-t',
        'ed25519',
        '-N',
        '',
        '-C',
        comment,
        '-f',
        keyPath,
      ], { timeout: 10_000 });
      const [privateKey, publicKey] = await Promise.all([
        readFile(keyPath, 'utf8'),
        readFile(`${keyPath}.pub`, 'utf8'),
      ]);
      return {
        privateKey,
        publicKey: publicKey.trim(),
        fingerprint: await this.fingerprint(keyPath),
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async fingerprint(keyPath: string): Promise<string> {
    const { stdout } = await execFileAsync('ssh-keygen', ['-y', '-f', keyPath], { timeout: 10_000 });
    const publicKey = stdout.trim();
    const dir = await mkdtemp(join(tmpdir(), 'nyabase-ssh-fp-'));
    const publicPath = join(dir, 'key.pub');
    try {
      await writeFile(publicPath, `${publicKey}\n`, 'utf8');
      const result = await execFileAsync('ssh-keygen', ['-l', '-E', 'sha256', '-f', publicPath], { timeout: 10_000 });
      const parts = result.stdout.trim().split(/\s+/);
      return parts[1] ?? '';
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
