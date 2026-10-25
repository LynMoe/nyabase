import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SizeField } from './size-slider.js';
import { QuotaLine, quotaFrom } from '../quota/quota-line.js';
import { SelectField } from '../layout/form-field.js';
import { sizeScale } from '../../lib/size-ladder.js';
import { GIB } from '../../lib/utils.js';

afterEach(() => {
  cleanup();
});

function Harness({ initial, availableGib = null }: { initial: string; availableGib?: number | null }) {
  const [value, setValue] = React.useState(initial);
  return (
    <SizeField
      id="mem"
      label="内存"
      value={value}
      onChange={setValue}
      scale={sizeScale('memory', 16)}
      availableGib={availableGib}
    />
  );
}

describe('SizeField', () => {
  it('shows the selected value and steps to neighbouring stops with the keyboard', () => {
    render(<Harness initial="2" />);
    const slider = screen.getByRole('slider');
    expect(screen.getByTestId('mem-value').textContent).toBe('2 GiB');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(screen.getByTestId('mem-value').textContent).toBe('3 GiB');
    fireEvent.keyDown(slider, { key: 'End' });
    expect((screen.getByLabelText('内存（GiB）') as HTMLInputElement).value).toBe('16');
  });

  it('moves a typed value between stops to the next stop', () => {
    render(<Harness initial="5" />);
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowLeft' });
    expect(screen.getByTestId('mem-value').textContent).toBe('4 GiB');
  });

  it('hatches the unavailable part and clamps the slider to what is left', () => {
    render(<Harness initial="2" availableGib={5.5} />);
    expect(screen.getByTestId('size-slider-unavailable')).toBeTruthy();
    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '8' } });
    expect(screen.getByTestId('mem-value').textContent).toBe('5.5 GiB');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(screen.getByTestId('mem-value').textContent).toBe('5.5 GiB');
  });

  it('still accepts a typed value above what is left', () => {
    render(<Harness initial="2" availableGib={4} />);
    fireEvent.change(screen.getByLabelText('内存（GiB）'), { target: { value: '12' } });
    expect(screen.getByTestId('mem-value').textContent).toBe('12 GiB');
  });
});

describe('QuotaLine', () => {
  it('describes limited, unlimited, unknown and loading quotas', () => {
    const { rerender } = render(<QuotaLine quota={quotaFrom(16 * GIB, 12 * GIB)} testId="q" />);
    expect(screen.getByTestId('q').textContent).toBe('剩余 12 GiB · 额度 16 GiB');
    rerender(<QuotaLine quota={quotaFrom(null, null)} testId="q" />);
    expect(screen.getByTestId('q').textContent).toBe('额度 不限');
    rerender(<QuotaLine quota={{ kind: 'unknown' }} testId="q" />);
    expect(screen.getByTestId('q').textContent).toBe('剩余 暂不可知');
    rerender(<QuotaLine quota={quotaFrom(undefined, undefined)} testId="q" />);
    expect(screen.getByTestId('q').textContent).toBe('剩余 …');
  });

  it('flags an over-quota selection unless the quota does not apply', () => {
    const quota = quotaFrom(16 * GIB, 1 * GIB);
    const { rerender } = render(<QuotaLine quota={quota} over testId="q" />);
    expect(screen.getByTestId('q').dataset.over).toBe('true');
    rerender(<QuotaLine quota={quota} over inactiveHint="不启动时不检查" testId="q" />);
    expect(screen.getByTestId('q').dataset.over).toBeUndefined();
    expect(screen.getByTestId('q').textContent).toContain('不启动时不检查');
  });
});

describe('SelectField emptyText', () => {
  it('disables an empty select and says why', () => {
    render(
      <SelectField
        id="server"
        label="服务器"
        value=""
        onChange={() => undefined}
        options={[]}
        emptyText="没有可用的服务器"
        emptyHint="请联系管理员分配。"
      />,
    );
    const trigger = screen.getByRole('combobox');
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    expect(trigger.textContent).toContain('没有可用的服务器');
    expect(screen.getByText('请联系管理员分配。')).toBeTruthy();
  });

  it('shows loading instead of empty while options load', () => {
    render(
      <SelectField id="server" label="服务器" value="" onChange={() => undefined} options={[]} loading emptyText="没有可用的服务器" />,
    );
    expect(screen.getByRole('combobox').textContent).toContain('加载中');
  });

  it('stays enabled with options', () => {
    render(
      <SelectField id="server" label="服务器" value="" onChange={() => undefined} options={[['a', 'A']]} emptyText="没有可用的服务器" />,
    );
    expect((screen.getByRole('combobox') as HTMLButtonElement).disabled).toBe(false);
  });
});
