import { Laptop, Moon, Sun } from 'lucide-react';
import { useThemeStore, type ThemeMode } from '../store/theme.js';
import { Button } from './ui/button.js';

const ORDER: ThemeMode[] = ['light', 'dark', 'system'];
const ICON = { light: Sun, dark: Moon, system: Laptop } as const;
const LABEL = { light: '浅色', dark: '深色', system: '跟随系统' } as const;

/**
 * Compact icon button that cycles through Light → Dark → System.
 *
 * Replace with a dropdown if more granular selection is needed; the underlying
 * store accepts the same three modes.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);
  const Icon = ICON[mode];

  const handleClick = () => {
    const next = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];
    setMode(next);
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleClick}
      className={className}
      title={`主题：${LABEL[mode]}（点击切换）`}
      aria-label={`切换主题，当前 ${LABEL[mode]}`}
    >
      <Icon className="h-4 w-4" />
      <span className="text-xs">{LABEL[mode]}</span>
    </Button>
  );
}
