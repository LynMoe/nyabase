import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { RouteIdPipe } from './http-filters.js';

describe('RouteIdPipe', () => {
  const pipe = new RouteIdPipe();
  const id = '6172518f-5edb-402b-ac2a-c0a899f53b0e';

  it('passes UUID path params and anything that is not a path param', () => {
    expect(pipe.transform(id, { type: 'param', data: 'id' })).toBe(id);
    expect(pipe.transform('undefined', { type: 'query', data: 'scope' })).toBe('undefined');
    expect(pipe.transform({ name: 'x' }, { type: 'body' })).toEqual({ name: 'x' });
  });

  it('turns a malformed path id into a 404', () => {
    expect(() => pipe.transform('undefined', { type: 'param', data: 'containerId' }))
      .toThrow(NotFoundException);
  });
});
