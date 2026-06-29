import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';

const VERSION = 'v1';

@Injectable()
export class SshKeyCryptoService {
  constructor(private config: NyabaseConfigService) {}

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decrypt(value: string): string {
    const [version, ivRaw, tagRaw, ciphertextRaw] = value.split('.');
    if (version !== VERSION || !ivRaw || !tagRaw || !ciphertextRaw) {
      throw new Error('Unsupported encrypted SSH key format');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(ivRaw, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextRaw, 'base64url')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  }

  private key(): Buffer {
    const secret = this.config.get<string>('ssh.keyEncryptionSecret')
      || this.config.get<string>('auth.jwtSecret');
    return createHash('sha256').update(secret).digest();
  }
}
