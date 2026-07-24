import { describe, expect, it } from 'vitest';
import {
  DockerEventNdjsonDecoder,
  MAX_DOCKER_EVENT_LINE_BYTES,
} from './docker-event-decoder.js';

describe('DockerEventNdjsonDecoder', () => {
  it('reassembles a split record and emits multiple records from one chunk', () => {
    const decoder = new DockerEventNdjsonDecoder();
    expect(decoder.push('{"status":"sta')).toEqual([]);
    expect(decoder.push('rt"}\n{"status":"stop"}\n')).toEqual([
      { status: 'start' },
      { status: 'stop' },
    ]);
  });

  it('accepts a complete final record without a trailing newline', () => {
    const decoder = new DockerEventNdjsonDecoder();
    expect(decoder.push('{"status":"die"}')).toEqual([]);
    expect(decoder.finish()).toEqual([{ status: 'die' }]);
  });

  it('rejects a malformed complete line and a malformed final tail', () => {
    expect(() => new DockerEventNdjsonDecoder().push('{bad}\n')).toThrow(/malformed NDJSON/);
    const decoder = new DockerEventNdjsonDecoder();
    decoder.push('{"status":');
    expect(() => decoder.finish()).toThrow(/malformed NDJSON/);
  });

  it('rejects invalid UTF-8 instead of replacing bytes inside an identity label', () => {
    const invalid = Buffer.concat([
      Buffer.from('{"Actor":{"Attributes":{"nyabase.managed":"'),
      Buffer.from([0xff]),
      Buffer.from('"}}}\n'),
    ]);
    expect(() => new DockerEventNdjsonDecoder().push(invalid)).toThrow(/malformed UTF-8/);
  });

  it('rejects non-object records and bounds an unterminated line', () => {
    expect(() => new DockerEventNdjsonDecoder().push('null\n')).toThrow(/JSON object/);
    const decoder = new DockerEventNdjsonDecoder();
    expect(() => decoder.push('a'.repeat(MAX_DOCKER_EVENT_LINE_BYTES + 1)))
      .toThrow(/exceeds/);
  });
});
