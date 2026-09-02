import type { ArgumentsHost } from '@nestjs/common';
import { PackageHttpError } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { PackageHttpErrorFilter } from './package-http-error.filter.js';

describe('PackageHttpErrorFilter', () => {
  it('maps PackageHttpError onto the HTTP envelope', () => {
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
      }),
    } as unknown as ArgumentsHost;

    new PackageHttpErrorFilter().catch(
      new PackageHttpError(409, 'EXTENSION_OCCUPIED', 'still claimed', { count: 2 }),
      host,
    );

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({
      statusCode: 409,
      code: 'EXTENSION_OCCUPIED',
      message: 'still claimed',
      details: { count: 2 },
    });
  });
});
