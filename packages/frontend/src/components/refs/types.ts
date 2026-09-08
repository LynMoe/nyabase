export type ResourceKind =
  | 'user'
  | 'group'
  | 'server'
  | 'container'
  | 'volume'
  | 'shared-volume'
  | 'image'
  | 'pool'
  | 'shared-backend';

export type ResourceRefProps = {
  kind: ResourceKind;
  id: string;
  name?: string;
};
