import { createFileRoute } from '@tanstack/react-router';
import ContainerDetailPage from '../../pages/container-detail-page.js';

export const Route = createFileRoute('/containers/$containerId')({
  component: ContainerDetailPage,
  validateSearch: (search: Record<string, unknown>) => ({
    tab: search.tab === 'console' ? 'console' as const : 'overview' as const,
  }),
});
