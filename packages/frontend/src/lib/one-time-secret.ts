export async function copyOneTimeSecret(
  secret: string,
  clipboard: Pick<Clipboard, 'writeText'> | undefined = globalThis.navigator?.clipboard,
): Promise<boolean> {
  if (!clipboard) return false;
  try {
    await clipboard.writeText(secret);
    return true;
  } catch {
    return false;
  }
}

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** 16 characters from an alphabet without look-alikes (0/O, 1/l/I), uniformly drawn. */
export function generateOneTimePassword(length = 16): string {
  // Bytes at or above the largest multiple of the alphabet size would bias the draw.
  const limit = 256 - (256 % PASSWORD_ALPHABET.length);
  const chars: string[] = [];
  const bytes = new Uint8Array(length * 2);
  while (chars.length < length) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < limit && chars.length < length) chars.push(PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length]!);
    }
  }
  return chars.join('');
}
