# Visual Inspection Log — ordinary user live probes

Timestamp: 2026-06-05T02:50+08:00
Viewport: Chromium 1366x900

## Screenshots inspected
- `ui/01-login-page.png`: login form reachable and visually usable.
- `ui/03-profile.png`: ordinary-user profile renders password + SSH-key panels; no clipping/overlap observed.
- `ui/04-admin-users-denied.png`: `/users` direct navigation shows explicit access-denied screen; no admin nav entry visible.
- `ui/06-create-dialog.png`: ordinary-user create dialog shows granted CPU server/image path; no clipping/overlap observed.
- `ui-admin-routes/admin-route-images.png`: `/images` direct navigation renders admin image management controls for ordinary user.
- `ui-admin-routes/admin-route-manage_containers.png`: `/manage/containers` direct navigation renders global-management shell for ordinary user.

## Judgment
- determinism: pass for fresh live render capture; screenshots were produced by a single browser probe against fixed local ports.
- quality: pass for login/profile/denied/create-dialog layout; fail for admin-only route authorization UX because several direct admin routes render management UI instead of denial/redirect.
- coverage: covers login, profile, one expected denied admin route, containers/create dialog, and representative unguarded admin routes.
