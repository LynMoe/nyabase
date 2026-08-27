import { createFileRoute } from '@tanstack/react-router';
import ContainerDetailPage, { parseDetailTab } from '../../pages/container-detail-page.js';

export const Route = createFileRoute('/containers/$containerId')({
  component: ContainerDetailPage,
  validateSearch: (search: Record<string, unknown>) => ({
    tab: parseDetailTab(search.tab),
  }),
});
