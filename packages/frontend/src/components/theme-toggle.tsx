import { Laptop, Moon, Sun } from 'lucide-react';
import { useThemeStore } from '../store/theme.js';
import { Button } from './ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.js';

const ICON = { light: Sun, dark: Moon, system: Laptop } as const;
const LABEL = { light: '浅色', dark: '深色', system: '系统' } as const;

export function ThemeToggle({ className }: { className?: string }) {
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);
  const Icon = ICON[mode];

  const handleModeChange = (value: string) => {
    if (value === 'light' || value === 'dark' || value === 'system') setMode(value);
  };

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={className}
          aria-label={`主题：${LABEL[mode]}`}
        >
          <Icon className="h-4 w-4" />
          <span className="text-xs">主题 · {LABEL[mode]}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={mode} onValueChange={handleModeChange}>
          <DropdownMenuRadioItem value="light">浅色</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">深色</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">系统</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
