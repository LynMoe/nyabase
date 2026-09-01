## Summary

Reviewed all 25 desktop shots at 1280×800. No page-level horizontal scrollbar, no overlapping chrome, and the client-cert expiry banner sits in its own strip above the title — it does not collide with headings, toolbars, or tables. Sidebar labels (including 数据卷管理 / SSH 代理 / 退出登录) are fully visible.

Two pages never paint their intended layout: **服务器详情** and **SSH 代理** both render the error boundary. Among pages that do render, the clear layout defect is the container overview Jump command, which is cut off mid-address. HTTP 代理’s instance table looks empty in the first columns. Everything else is mostly spacing: stretched/half-width cards and a couple of sections pushed below the fold.

Clean (no layout issues at this viewport): `login.png`, `dashboard.png`, `containers.png`, `container-storage.png`, `container-spec.png`, `container-intents.png`, `volumes.png`, `http-proxy.png`, `ip-pools.png`, `storage-pools.png`, `manage-containers.png`, `manage-volumes.png`, `users.png`, `groups.png`, `audit.png`. Tables on 存储池 / HTTP 代理 / 审计 / 系统设置 stay inside their cards.

## Issues

### Issue 1 -- Severity: bug
- File: packages/frontend/visual/shots/desktop/server-detail.png
- Description: The server detail view never renders. The main pane is a centered error card: “页面出错了” with `Objects are not valid as a React child (found: object with keys {name, ok, detail})`. Sidebar and cert banner are fine; there is no header, tabs, or server content to review.
- Suggestion: Render preflight/check results as strings (or a list of `{name, ok, detail}` rows) instead of passing the object as a React child, then recapture this shot.
- Status: open

### Issue 2 -- Severity: bug
- File: packages/frontend/visual/shots/desktop/ssh-proxy.png
- Description: Same error-boundary takeover on SSH 代理: `Cannot read properties of undefined (reading 'map')`. The page has no title, metrics, or tables — only the fallback card in the content column.
- Suggestion: Guard the status payload before `.map` (empty list when proxies/bindings are missing) so the page shell still paints.
- Status: open

### Issue 3 -- Severity: bug
- File: packages/frontend/visual/shots/desktop/container-overview.png
- Description: In the SSH 登录信息 card, the Jump command `<pre>` is a single unwrapped line. At this width it is cut off at `ubuntu@1`; the destination (`ubuntu@10.20.0.15`, visible in the config snippet below) is not readable. No scrollbar is visible on the gray command box. The `~/.ssh/config` block wraps correctly; this one does not.
- Suggestion: Wrap the command (`whitespace-pre-wrap` / `break-all`) so the full `ssh -J … ubuntu@10.20.0.15` is visible in the card without inner horizontal scroll.
- Status: open

### Issue 4 -- Severity: bug
- File: packages/frontend/visual/shots/desktop/http-proxy-ops.png
- Description: The 代理实例 table stays in its card, but the only data row is visually blank in **代理** and **HTTP**. HTTPS shows `-`, 连接 shows `3`, and 请求 shows only `/拒绝`. Metric tiles above report 累计请求 900 and 拒绝 2, so the last cell looks truncated/incomplete versus the expected `N / 拒绝 M` pattern. A five-column table with an unidentified proxy is the densest content failure in this batch.
- Suggestion: Always show `hostname` or `proxyId`, `httpListen`, and both request counters in that row (and avoid a fixed one-line cell height if the id needs a second line).
- Status: open

### Issue 5 -- Severity: suggestion
- File: packages/frontend/visual/shots/desktop/group-detail.png
- Description: The 基本信息 card is a single description field plus 保存, but it is padded out to roughly half the viewport. That leftover gap pushes **服务器授权** to the bottom edge: only the card title is visible; the grant form is clipped by the 800px fold. Cert banner is not overlapping it — the sparse first card is.
- Suggestion: Tighten CardHeader/CardContent spacing when the system group has no capability grid, so 服务器授权 (server/GPU/quota fields) starts on the first screen.
- Status: open

### Issue 6 -- Severity: suggestion
- File: packages/frontend/visual/shots/desktop/profile.png
- Description: 修改密码 is one card stretched to the full height of the right column (SSH 公钥 list + 添加公钥). After 确认修改 there is a large empty interior. Not overlapping, but the left card looks hollow next to the stacked SSH cards.
- Suggestion: Stop stretching the password card (`align-items: start` on the two-column grid) so its height follows the three fields.
- Status: open

### Issue 7 -- Severity: nit
- File: packages/frontend/visual/shots/desktop/shared-backends.png
- Description: Admin resource lists use a 2-up card grid. With a single item, the right half of the main column is empty. Inside this card the Ceph FSID wraps mid-token (`…-eeeeee` / `eeeeee` on the next line). Same half-width empty column appears on `servers.png`, `ip-pools.png`, `images.png`, `volumes.png`, and `http-proxy.png`. Full-width rows on 容器/用户/用户组 do not have this gap.
- Suggestion: Let a lone card grow toward the content width (or cap at a larger max-width) so UUIDs/FSIDs stay on one line.
- Status: open
