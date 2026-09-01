import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { QueryErrorState, QueryLoadingState, queryErrorPresentation } from '../query-state.js';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert.js';
import { queryPresentationState } from '../../lib/query-presentation.js';

export type QueryLike<T> = {
  data: T | undefined;
  isPending: boolean;
  isFetching: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
};

export function isQueryLoading(q: QueryLike<unknown>): boolean {
  return q.data === undefined && q.isPending && q.isFetching;
}

function isQueryIdle(q: QueryLike<unknown>): boolean {
  return q.data === undefined && q.isPending && !q.isFetching && !q.isError;
}

type SingleQueryViewProps<T> = {
  query: QueryLike<T>;
  resourceName: string;
  loadingLabel: string;
  onBack?: () => void;
  empty?: React.ReactNode;
  showEmpty?: boolean;
  skeleton?: React.ReactNode;
  children: (data: T) => React.ReactNode;
};

type MultiQueryViewProps = {
  queries: QueryLike<unknown>[];
  resourceNames: string[];
  loadingLabel: string;
  onBack?: () => void;
  children: () => React.ReactNode;
};

function StaleErrorAlert({ error, resourceName }: { error: unknown; resourceName: string }) {
  const presentation = queryErrorPresentation(error, resourceName);
  return (
    <Alert variant="destructive">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>{presentation.title}</AlertTitle>
      <AlertDescription>{presentation.description}</AlertDescription>
    </Alert>
  );
}

export function QueryView<T>(props: SingleQueryViewProps<T>): React.ReactNode;
export function QueryView(props: MultiQueryViewProps): React.ReactNode;
export function QueryView<T>(
  props: SingleQueryViewProps<T> | MultiQueryViewProps,
): React.ReactNode {
  const isMulti = 'queries' in props;
  const queries = isMulti ? props.queries : [props.query];
  const resourceNames = isMulti ? props.resourceNames : [props.resourceName];

  if (queries.some(isQueryIdle)) return null;

  const presentations = queries.map((q) =>
    queryPresentationState({
      hasData: q.data !== undefined,
      isLoading: isQueryLoading(q),
      isError: q.isError,
    }),
  );

  if (presentations.some((state) => state === 'loading')) {
    if (!isMulti && props.skeleton) return props.skeleton;
    return <QueryLoadingState label={props.loadingLabel} />;
  }

  const errorIndex = presentations.findIndex((state) => state === 'error');
  if (errorIndex !== -1) {
    const failed = queries[errorIndex];
    return (
      <QueryErrorState
        error={failed.error}
        resourceName={resourceNames[errorIndex]}
        onRetry={() => {
          void failed.refetch();
        }}
        onBack={props.onBack}
      />
    );
  }

  const staleAlerts = presentations.flatMap((state, index) =>
    state === 'stale-error'
      ? [
          <StaleErrorAlert
            key={resourceNames[index] ?? index}
            error={queries[index].error}
            resourceName={resourceNames[index] ?? '内容'}
          />,
        ]
      : [],
  );

  if (isMulti) {
    return (
      <>
        {staleAlerts}
        {props.children()}
      </>
    );
  }

  const data = props.query.data;
  if (data === undefined || props.showEmpty) {
    return (
      <>
        {staleAlerts}
        {props.showEmpty ? props.empty : null}
      </>
    );
  }

  return (
    <>
      {staleAlerts}
      {props.children(data)}
    </>
  );
}
