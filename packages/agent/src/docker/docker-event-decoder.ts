import { isUtf8 } from 'node:buffer';

export const MAX_DOCKER_EVENT_LINE_BYTES = 256 * 1024;

/**
 * Docker's events endpoint is an unbounded NDJSON stream. Node stream chunks
 * are transport fragments, not JSON record boundaries, so retain only one
 * bounded partial line and emit every complete object in order.
 */
export class DockerEventNdjsonDecoder {
  private partial = Buffer.alloc(0);

  constructor(private readonly maxLineBytes = MAX_DOCKER_EVENT_LINE_BYTES) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
      throw new Error('Docker event line limit must be a positive safe integer');
    }
  }

  push(chunk: Buffer | string): Record<string, unknown>[] {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const events: Record<string, unknown>[] = [];
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline === -1 ? bytes.length : newline;
      this.append(bytes.subarray(offset, end));
      if (newline === -1) break;
      const event = this.consumeLine();
      if (event) events.push(event);
      offset = newline + 1;
    }
    return events;
  }

  finish(): Record<string, unknown>[] {
    if (this.partial.length === 0) return [];
    const event = this.consumeLine();
    return event ? [event] : [];
  }

  private append(segment: Buffer): void {
    if (this.partial.length + segment.length > this.maxLineBytes) {
      this.partial = Buffer.alloc(0);
      throw new Error(`Docker event line exceeds ${this.maxLineBytes} bytes`);
    }
    if (segment.length === 0) return;
    this.partial = this.partial.length === 0
      ? Buffer.from(segment)
      : Buffer.concat([this.partial, segment], this.partial.length + segment.length);
  }

  private consumeLine(): Record<string, unknown> | null {
    let line = this.partial;
    this.partial = Buffer.alloc(0);
    if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
    if (line.length === 0) return null;
    if (!isUtf8(line)) throw new Error('Docker event stream contains malformed UTF-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.toString('utf8'));
    } catch (error) {
      throw new Error('Docker event stream contains malformed NDJSON', { cause: error });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Docker event stream record must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  }
}
