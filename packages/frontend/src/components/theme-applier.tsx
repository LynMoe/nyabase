import { useEffect } from 'react';
import { resolveAppliedTheme, useThemeStore } from '../store/theme.js';

/**
 * Applies the persisted theme preference to <html> and reacts to OS-level
 * color-scheme changes while `mode === 'system'`.
 *
 * Mount once near the application root (before `RouterProvider`).
 */
export function ThemeApplier(): null {
  const mode = useThemeStore((s) => s.mode);

  useEffect(() => {
    const apply = () => {
      const applied = resolveAppliedTheme(mode);
      const root = document.documentElement;
      root.classList.toggle('dark', applied === 'dark');
      root.style.colorScheme = applied;
    };
    apply();

    if (mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [mode]);

  return null;
}
