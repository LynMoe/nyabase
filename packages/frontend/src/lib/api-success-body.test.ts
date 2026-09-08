import { describe, expect, it } from 'vitest';
import { ApiError } from './api-error.js';
import { parseSuccessfulResponseBody } from './api.js';

describe('parseSuccessfulResponseBody', () => {
  it('treats 204 and empty 200 as a void success', () => {
    expect(parseSuccessfulResponseBody(204, '')).toBeUndefined();
    expect(parseSuccessfulResponseBody(205, '   ')).toBeUndefined();
    expect(parseSuccessfulResponseBody(200, '')).toBeUndefined();
    expect(parseSuccessfulResponseBody(200, ' \n')).toBeUndefined();
  });

  it('parses a JSON success body', () => {
    expect(parseSuccessfulResponseBody(200, '{"id":"b1"}')).toEqual({ id: 'b1' });
  });

  it('rejects malformed JSON with INVALID_RESPONSE', () => {
    try {
      parseSuccessfulResponseBody(200, '<html>nope</html>');
      throw new Error('expected INVALID_RESPONSE');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 502, code: 'INVALID_RESPONSE' });
    }
  });
});
