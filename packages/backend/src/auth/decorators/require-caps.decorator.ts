import { SetMetadata } from '@nestjs/common';
import { Capability } from '@nyabase/common';

export const CAPS_KEY = 'required_capabilities';
export const RequireCaps = (...caps: Capability[]) => SetMetadata(CAPS_KEY, caps);
