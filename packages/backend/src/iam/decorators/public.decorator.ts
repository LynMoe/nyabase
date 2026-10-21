import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'is_public_route';

/** Opts a route out of the global JWT and capability guards. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
