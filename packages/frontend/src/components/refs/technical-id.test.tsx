import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TechnicalId } from './technical-id.js';

afterEach(() => {
  cleanup();
});

const FINGERPRINT = 'ab'.repeat(32);

function hover(element: HTMLElement) {
  fireEvent.pointerMove(element, { pointerType: 'mouse' });
}

describe('TechnicalId', () => {
  it('shows an alias plus the first 6 fingerprint characters', () => {
    render(<TechnicalId label="镜像" kind="fingerprint" alias="ubuntu/24.04" value={FINGERPRINT} />);
    const trigger = screen.getByLabelText(`镜像 ${FINGERPRINT}`);
    expect(trigger.textContent).toBe('ubuntu/24.04 ababab');
    expect(trigger.className).toContain('bg-repeat-x');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText('尚未收敛')).toBeNull();
    expect(screen.queryByText('等待收敛')).toBeNull();
  });

  it('shows only 6 characters when a fingerprint has no alias', () => {
    render(<TechnicalId label="指纹" kind="fingerprint" value={FINGERPRINT} />);
    expect(screen.getByLabelText(`指纹 ${FINGERPRINT}`).textContent).toBe('ababab');
  });

  it('renders a short opaque value as plain text', () => {
    render(<TechnicalId label="实例名" value="short" />);
    const text = screen.getByText('short');
    expect(screen.queryByRole('button')).toBeNull();
    expect(text.className).not.toContain('bg-repeat-x');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('shows the full value in a tooltip on hover', async () => {
    render(<TechnicalId label="实例名" value="instance-name-that-is-long" />);
    const trigger = screen.getByLabelText('实例名 instance-name-that-is-long');
    expect(trigger.textContent).toBe('instance…');
    expect(trigger.className).toContain('bg-repeat-x');
    expect(screen.queryByRole('tooltip')).toBeNull();

    hover(trigger);
    expect((await screen.findByRole('tooltip')).textContent).toBe('instance-name-that-is-long');
    expect(trigger.textContent).toBe('instance…');
  });
});
