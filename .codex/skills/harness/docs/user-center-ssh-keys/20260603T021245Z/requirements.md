# Requirements

## Original request

User asked in Chinese:

> 现在前端有用户ssh密钥管理的功能吗？把修改密码改为用户中心，点击后可以修改密码或者管理ssh公钥，用于容器登录

## Intake findings

- Backend already exposes self-service SSH public key endpoints:
  - `GET /users/:id/ssh-keys`
  - `POST /users/:id/ssh-keys`
  - `DELETE /users/:id/ssh-keys/:keyId`
- Backend allows users to manage their own keys; managers can manage other users' keys.
- Frontend currently has a sidebar `修改密码` action that opens a password-only dialog in `packages/frontend/src/components/layout/app-layout.tsx`.
- Frontend currently does not expose a current-user SSH public key management UI.
- Existing container SSH UX already refers to using `用户中心公钥` for root login.

## Proposed scope

Include:

- Rename the sidebar action from `修改密码` to `用户中心`.
- Add a dedicated `/profile` user center page for the current logged-in user.
- Link the sidebar `用户中心` action to `/profile`.
- Keep password change available inside the user center page.
- Add SSH public key management inside the user center page:
  - list current user's SSH public keys;
  - add a key with display name and public key text;
  - delete an existing key;
  - present the relationship to container SSH login clearly.
- Add/update frontend visual coverage for the new user center state.

Exclude:

- No backend API redesign unless implementation finds a blocking bug.
- No container SSH protocol or agent behavior changes.
- No admin UI for managing other users' SSH keys unless explicitly requested later.

## Draft acceptance criteria

1. Sidebar no longer shows `修改密码`; it shows `用户中心`.
2. Clicking `用户中心` navigates to `/profile`, where the user can change their password.
3. The same page shows existing SSH public keys for the current user.
4. The user can add and delete SSH public keys through the existing `/users/:id/ssh-keys` API.
5. UI copy makes clear that SSH public keys are used for container login.
6. Existing common source artifact invariant remains satisfied: no generated `.js`, `.js.map`, `.d.ts`, or `.d.ts.map` under `packages/common/src/**`.
