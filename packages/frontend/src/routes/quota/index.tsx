import { createFileRoute, redirect } from '@tanstack/react-router';

// 配额 now lives on the 概览 page; keep old links working.
export const Route = createFileRoute('/quota/')({
  beforeLoad: () => {
    throw redirect({ to: '/', hash: 'quota', replace: true });
  },
});
