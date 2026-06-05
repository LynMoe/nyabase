/**
 * Public API for dashboard charts.
 *
 * The recharts-using implementations live in `./metrics-charts.tsx` and are
 * loaded via `React.lazy` so recharts is split into its own async chunk and
 * does not enter the first-paint bundle.
 *
 * Layout-only helpers (SkeletonSection, EmptyChart, TimeRangeSelector,
 * formatters) are re-exported synchronously from `./metrics-shared.tsx` since
 * they're tiny and used by both lazy and non-lazy paths.
 */
import { lazy, Suspense, type ComponentProps } from 'react';

import {
  ChartLoading,
} from './metrics-shared.js';

const ChartsModule = () => import('./metrics-charts.js');
const LazySingleLineChart = lazy(() =>
  ChartsModule().then((m) => ({ default: m.SingleLineChartImpl })),
);
const LazyInlineSingleLineChart = lazy(() =>
  ChartsModule().then((m) => ({ default: m.InlineSingleLineChartImpl })),
);
const LazyMultiLineChart = lazy(() =>
  ChartsModule().then((m) => ({ default: m.MultiLineChartImpl })),
);
const LazyChartCard = lazy(() =>
  ChartsModule().then((m) => ({ default: m.ChartCard })),
);
const LazyHostSection = lazy(() =>
  ChartsModule().then((m) => ({ default: m.HostSectionImpl })),
);
const LazyGpuSection = lazy(() =>
  ChartsModule().then((m) => ({ default: m.GpuSectionImpl })),
);

export function SingleLineChart(props: ComponentProps<typeof LazySingleLineChart>) {
  return (
    <Suspense fallback={<ChartLoading title={props.title} />}>
      <LazySingleLineChart {...props} />
    </Suspense>
  );
}

export function InlineSingleLineChart(props: ComponentProps<typeof LazyInlineSingleLineChart>) {
  return (
    <Suspense fallback={<ChartLoading title={props.title} height={props.height} />}>
      <LazyInlineSingleLineChart {...props} />
    </Suspense>
  );
}

export function MultiLineChart(props: ComponentProps<typeof LazyMultiLineChart>) {
  return (
    <Suspense fallback={<ChartLoading title={props.title} height={180} />}>
      <LazyMultiLineChart {...props} />
    </Suspense>
  );
}

export function ChartCard(props: ComponentProps<typeof LazyChartCard>) {
  return (
    <Suspense fallback={<ChartLoading title={props.title} height={props.height} />}>
      <LazyChartCard {...props} />
    </Suspense>
  );
}

export function HostSection(props: ComponentProps<typeof LazyHostSection>) {
  return (
    <Suspense fallback={<ChartLoading height={400} />}>
      <LazyHostSection {...props} />
    </Suspense>
  );
}

export function GpuSection(props: ComponentProps<typeof LazyGpuSection>) {
  return (
    <Suspense fallback={<ChartLoading height={300} />}>
      <LazyGpuSection {...props} />
    </Suspense>
  );
}

// Re-export recharts-free helpers so existing imports keep working.
export {
  AXIS_TICK,
  ChartLoading,
  EmptyChart,
  GRID_STROKE,
  SectionHeader,
  SkeletonSection,
  TIP_STYLE,
  TimeRangeSelector,
  colorFor,
  fmtBps,
  fmtPercent,
  fmtTime,
  multiSeriesData,
  singleSeriesData,
  zeroFillSeriesFromReferences,
} from './metrics-shared.js';
export type { ChartPoint } from './metrics-shared.js';
