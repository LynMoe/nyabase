import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAgentSecret } from '@nyabase/common';

const CREDENTIAL_FILE = 'credential';

/** The agent's long-lived Backend credential, kept 0600 under the state directory. */
export class CredentialStore {
  constructor(private readonly stateDir: string) {}

  async read(): Promise<string | undefined> {
    let value: string;
    try {
      value = (await readFile(join(this.stateDir, CREDENTIAL_FILE), 'utf8')).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (!parseAgentSecret('credential', value)) {
      throw new Error(`${join(this.stateDir, CREDENTIAL_FILE)} does not hold an agent credential`);
    }
    return value;
  }

  async write(credential: string): Promise<void> {
    if (!parseAgentSecret('credential', credential)) {
      throw new Error('Refusing to store a malformed agent credential');
    }
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const target = join(this.stateDir, CREDENTIAL_FILE);
    const temporary = `${target}.tmp`;
    await writeFile(temporary, `${credential}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }
}
