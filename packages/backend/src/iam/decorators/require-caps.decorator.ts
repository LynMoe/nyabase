import { SetMetadata } from '@nestjs/common';
import { Capability } from '@nyabase/common';

export const CAPS_KEY = 'required_capabilities';
export const ANY_CAPS_KEY = 'required_any_capability';
export const RequireCaps = (...caps: Capability[]) => SetMetadata(CAPS_KEY, caps);
export const RequireAnyCaps = (...caps: Capability[]) => SetMetadata(ANY_CAPS_KEY, caps);
