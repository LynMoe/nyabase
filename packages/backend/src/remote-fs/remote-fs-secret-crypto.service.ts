import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';

const VERSION = 'rfs-v1';

@Injectable()
export class RemoteFsSecretCryptoService {
  constructor(private config: NyabaseConfigService) {}

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      VERSION,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decryptIfEncrypted(value: string): string {
    if (!this.isEncrypted(value)) return value;
    const [, ivRaw, tagRaw, ciphertextRaw] = value.split('.');
    const decipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(ivRaw, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextRaw, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  isEncrypted(value: string): boolean {
    return value.startsWith(`${VERSION}.`);
  }

  private key(): Buffer {
    const secret = this.config.get<string>('ssh.keyEncryptionSecret')
      || this.config.get<string>('auth.jwtSecret');
    return createHash('sha256').update(secret).digest();
  }
}
