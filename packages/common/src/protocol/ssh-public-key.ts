const ACCEPTED_KEY_TYPES = new Set([
  'ssh-ed25519',
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
]);

const ECDSA_CURVES: Record<string, string> = {
  'ecdsa-sha2-nistp256': 'nistp256',
  'ecdsa-sha2-nistp384': 'nistp384',
  'ecdsa-sha2-nistp521': 'nistp521',
  'sk-ecdsa-sha2-nistp256@openssh.com': 'nistp256',
};

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

interface SshField {
  value: Uint8Array;
  nextOffset: number;
}

export function normalizeOpenSshPublicKey(input: string): string | null {
  if (input.includes('\n') || input.includes('\r')) return null;

  const parts = input.trim().split(/[ \t]+/).filter((part) => part.length > 0);
  if (parts.length < 2) return null;

  const [keyType, keyBlob, ...commentParts] = parts;
  if (!keyType || !keyBlob || !ACCEPTED_KEY_TYPES.has(keyType)) return null;
  if (!isValidBase64(keyBlob)) return null;

  const blob = decodeBase64(keyBlob);
  if (!blob || blob.length === 0) return null;
  if (!isValidOpenSshKeyBlob(keyType, blob)) return null;

  return [keyType, keyBlob, ...commentParts].join(' ');
}

export function isOpenSshPublicKey(input: string): boolean {
  return normalizeOpenSshPublicKey(input) !== null;
}

function isValidBase64(input: string): boolean {
  if (input.length === 0 || input.length % 4 === 1 || !BASE64_RE.test(input)) {
    return false;
  }
  if (input.includes('=') && input.length % 4 !== 0) {
    return false;
  }
  return true;
}

function decodeBase64(input: string): Uint8Array | null {
  try {
    const paddedInput = input.padEnd(
      input.length + ((4 - (input.length % 4)) % 4),
      '=',
    );
    if (typeof globalThis.atob === 'function') {
      const binary = globalThis.atob(paddedInput);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    }

    const bufferCtor = (globalThis as {
      Buffer?: {
        from: (value: string, encoding: 'base64') => { length: number; [index: number]: number };
      };
    }).Buffer;
    if (!bufferCtor) return null;

    const buffer = bufferCtor.from(paddedInput, 'base64');
    const bytes = new Uint8Array(buffer.length);
    for (let i = 0; i < buffer.length; i += 1) {
      bytes[i] = buffer[i];
    }
    return bytes;
  } catch {
    return null;
  }
}

function isValidOpenSshKeyBlob(expectedType: string, bytes: Uint8Array): boolean {
  const typeField = readString(bytes, 0);
  if (!typeField) return false;

  const embeddedType = decodeUtf8(typeField.value);
  if (embeddedType !== expectedType) return false;

  switch (expectedType) {
    case 'ssh-ed25519':
      return hasFields(bytes, typeField.nextOffset, [32]);
    case 'sk-ssh-ed25519@openssh.com':
      return hasFields(bytes, typeField.nextOffset, [32, null]);
    case 'ssh-rsa':
      return hasFields(bytes, typeField.nextOffset, [null, null]);
    case 'ecdsa-sha2-nistp256':
    case 'ecdsa-sha2-nistp384':
    case 'ecdsa-sha2-nistp521':
      return hasEcdsaFields(bytes, typeField.nextOffset, expectedType, false);
    case 'sk-ecdsa-sha2-nistp256@openssh.com':
      return hasEcdsaFields(bytes, typeField.nextOffset, expectedType, true);
    default:
      return false;
  }
}

function hasEcdsaFields(
  bytes: Uint8Array,
  offset: number,
  keyType: string,
  hasApplication: boolean,
): boolean {
  const curveField = readString(bytes, offset);
  if (!curveField) return false;
  if (decodeUtf8(curveField.value) !== ECDSA_CURVES[keyType]) return false;

  const pointField = readString(bytes, curveField.nextOffset);
  if (!pointField || pointField.value.length === 0) return false;

  if (!hasApplication) return pointField.nextOffset === bytes.length;

  const applicationField = readString(bytes, pointField.nextOffset);
  return !!applicationField
    && applicationField.value.length > 0
    && applicationField.nextOffset === bytes.length;
}

function hasFields(
  bytes: Uint8Array,
  offset: number,
  expectedLengths: Array<number | null>,
): boolean {
  let cursor = offset;
  for (const expectedLength of expectedLengths) {
    const field = readString(bytes, cursor);
    if (!field || field.value.length === 0) return false;
    if (expectedLength !== null && field.value.length !== expectedLength) return false;
    cursor = field.nextOffset;
  }
  return cursor === bytes.length;
}

function readString(bytes: Uint8Array, offset: number): SshField | null {
  if (offset + 4 > bytes.length) return null;
  const length =
    (bytes[offset] << 24)
    | (bytes[offset + 1] << 16)
    | (bytes[offset + 2] << 8)
    | bytes[offset + 3];
  if (length < 0) return null;

  const start = offset + 4;
  const end = start + length;
  if (end > bytes.length) return null;

  return {
    value: bytes.slice(start, end),
    nextOffset: end,
  };
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
