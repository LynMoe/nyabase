import { Role, roleAtLeast } from '@nyabase/common';
import { useAuthStore } from '../store/auth.js';

/** True when the signed-in user's role is `minimum` or above (roles are strictly nested). */
export function useHasRole(minimum: Role): boolean {
  return useAuthStore((state) => (state.user ? roleAtLeast(state.user.role, minimum) : false));
}
