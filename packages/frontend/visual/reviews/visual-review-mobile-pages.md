## Summary

Reviewed all 26 listed 390×844 (captured at 780×1688) mobile screenshots.

What is fine at this width:
- Hamburger + brand (`nyabase`) never collide; the mobile chrome does not put a page title next to the menu.
- Cert expiry banner stays on **one line** (`客户端证书将于 2026/9/20 过期，请轮换 前往轮换`) and does not wrap or collide with the header.
- No screenshot is wider than the viewport. `html { overflow-x: hidden }` also hides page-level horizontal scroll, so overflow shows up as **clipping**, not as a sideways page.
- Card/list pages (login, dashboard, volumes, HTTP 发布, profile, servers, IP 池, shared-backends, group-detail, manage-volumes, system-settings forms) stack cleanly. Sparse lists have large empty space below a single item; that is empty data, not a broken layout.
- Container detail breadcrumbs (`容器 > dev-workspace`) and group breadcrumbs (`用户组 > users`) stay on one line.

Real problems: two pages crash into the error boundary; three tables clip or squeeze columns instead of presenting an inner-scroll surface; the mobile nav sheet hides 审计 / 系统设置 below the fold with no cue; container tabs wrap; container list rows crush the status badge.

## Issues

### Issue 1 -- Severity: bug
- File: packages/frontend/visual/shots/mobile/server-detail.png
- Description: Server detail is not a layout at all — the page is the error boundary. Title `页面出错了`, message `Objects are not valid as a React child (found: object with keys {name, ok, detail})`. The error card sits in a large empty white region under the cert banner. The whole server-detail surface is unusable on mobile (and almost certainly on desktop too).
- Suggestion: Stop rendering the preflight/health object as a React child; unwrap `{name, ok, detail}` to a string (or a small status list) before paint.
- Status: open

### Issue 2 -- Severity: bug
- File: packages/frontend/visual/shots/mobile/ssh-proxy.png
- Description: SSH 代理 is also the error boundary: `Cannot read properties of undefined (reading 'map')`. Same huge empty region with a centered error card. No metrics, tables, or host-key UI render.
- Suggestion: Guard `proxies` (and any other list) as `data?.proxies ?? []` before `.map`; do not assume the status payload is present on first paint.
- Status: open

### Issue 3 -- Severity: bug
- File: packages/frontend/visual/shots/mobile/storage-pools.png
- Description: Storage-pool table is clipped by the card, not presented as an inner-scrolling table. Visible header is `池`, `容量`, then a sliced `能` (from `能力`). Capacity wraps as `120 GB / 500` / `GB`. A green capability badge is cut off by the rounded `overflow-hidden` edge. Remaining columns (`能力` rest, `共享后端`, `状态`, `操作`) are off-screen with no scrollbar or fade. The table is `min-w-[800px]` inside `overflow-hidden` + the shared `Table` `overflow-x-auto` wrapper — swipe-to-scroll may exist in code, but the resting frame looks like a broken, truncated table, not a scrollable one.
- Suggestion: Keep `overflow-x-auto` on the visible scrollport (not behind `overflow-hidden` that clips the bar). Add a mobile card/stack for pools (name, capacity, badges, register action) instead of a 6-column 800px table. If the table stays, show a persistent scrollbar or “左右滑动” hint.
- Status: open

### Issue 4 -- Severity: bug
- File: packages/frontend/visual/shots/mobile/audit.png
- Description: Audit table shows only `时间` and `操作者`. `操作`, `目标`, and `查看` are gone. The table is `min-w-[760px] table-fixed` inside `overflow-hidden`; first two heads are `w-44` + `w-48` (~368px), so they consume the 390px card and the rest is off-canvas. No scrollbar, shadow, or peek of the next column. Pagination (`每页 50` / `上一页` / `下一页`) itself fits. Result: on mobile you cannot see the action, target, or open the detail button without knowing to swipe a table that looks complete.
- Suggestion: Same as storage pools — inner scroll must be obvious, or replace the table on small screens with stacked rows (`时间`, actor, action chip, target, `查看`).
- Status: open

### Issue 5 -- Severity: bug
- File: packages/frontend/visual/shots/mobile/http-proxy-ops.png
- Description: `代理实例` is a 5-column table (`代理` `HTTP` `HTTPS` `连接` `请求`) squeezed into the card instead of given a min-width and inner scroll. Data row is visually broken: `代理` and `HTTP` cells look empty, `HTTPS` is `-`, `连接` is `3`, `请求` is truncated to `/ 拒绝` (full value is `{totalRequests} / 拒绝 {totalRejectedRequests}`, e.g. `900 / 拒绝 2`). Unlike the other tables this one has no `min-w-[…]`, so columns shrink and cell text clips. Metric tiles above the table are fine (1-col stack).
- Suggestion: Stack each proxy as a card (hostname/id, listen ports, connections, request/reject counts). If keeping a table, set a min-width and make horizontal scroll visible; `whitespace-nowrap` on the request cell.
- Status: open

### Issue 6 -- Severity: bug
- File: packages/frontend/visual/shots/mobile/mobile-nav-sheet.png
- Description: The left Sheet is `w-56` (224px). Labels are **not** horizontally truncated (`数据卷管理`, `HTTP 发布` fit). Vertical truncation is the problem: the scroll region ends at `用户组`, then the pinned footer shows theme toggle `系统` and `退出登录`. Admin items `审计` and `系统设置` are below the fold with no scrollbar, fade, or peek. A user can easily think the nav ends at 用户组. The footer label `系统` (theme = system) also sits where `系统设置` would be, which makes the missing item easier to miss.
- Suggestion: Widen the sheet (`w-72` / `max-w-[85vw]`), drop the last nav items into the same scrollport as the footer or add a bottom fade + always-visible scroll. Do not pin theme/logout until every admin item has been scrolled through, or show a “还有 2 项” cue. Rename the theme trigger so it cannot be read as 系统设置 (e.g. `主题：系统`).
- Status: open

### Issue 7 -- Severity: suggestion
- File: packages/frontend/visual/shots/mobile/container-overview.png
- File: packages/frontend/visual/shots/mobile/container-storage.png
- File: packages/frontend/visual/shots/mobile/container-spec.png
- File: packages/frontend/visual/shots/mobile/container-intents.png
- Description: Container detail `TabsList` is `flex-wrap`. First row: `概览` `存储` `规格` `意图历史`. Second row: `控制台` alone on the gray pill background. Action buttons (`启动` `停止` `重启` `删除`) fit one row. Breadcrumb and title do not wrap. The wrapped tab strip looks like a broken toolbar rather than a tab list; 控制台 is easy to miss.
- Suggestion: `flex-nowrap overflow-x-auto` on `TabsList` (horizontal scroll, no wrap), or a compact select/segment on small screens. Keep `h-auto` only if you also make the strip a single scrolling row.
- Status: open

### Issue 8 -- Severity: suggestion
- File: packages/frontend/visual/shots/mobile/containers.png
- File: packages/frontend/visual/shots/mobile/manage-containers.png
- Description: Container rows keep icon actions (`▶` `□` `↻` `>`) on the same line as the name. Name truncates to `dev-works…`; subtitle truncates (`10.20.0.15…` / `平台管理员 · lab-node-a…`). The `运行中` success badge is squeezed into a two-line green circle (`运行` over `中`) instead of a pill. The name `span` uses `truncate` without `min-w-0 flex-1`, and the badge has no `shrink-0` / `whitespace-nowrap`, so the badge loses the fight for width. Row `flex-wrap` never actually wraps because the icon cluster is `shrink-0` on the same line.
- Suggestion: `span.min-w-0.flex-1.truncate` for the name; `Badge` `shrink-0 whitespace-nowrap`. On narrow screens, wrap the icon bar to the next line (or use a single overflow menu) so the name can stay `dev-workspace`.
- Status: open

### Issue 9 -- Severity: suggestion
- File: packages/frontend/visual/shots/mobile/users.png
- Description: Alice Chen’s actions wrap: `授权` `停用` `重置密码` on one row, `删除` on the next. Admin’s only action (`授权`) stays top-right, so the two rows look inconsistent. Wrapping avoids overflow (good) but the four buttons eat a lot of vertical space and the destructive button sits alone under the chips.
- Suggestion: Collapse per-user actions into an overflow/menu on small screens; keep `授权` visible. `flex-wrap` can stay as a fallback.
- Status: open

### Issue 10 -- Severity: nit
- File: packages/frontend/visual/shots/mobile/images.png
- Description: In the assignment sub-card, the `服务器分配` label wraps to two lines (`服务器` / `分配`) beside a full-width `添加服务器…` select. Edit/Delete at the card footer wrap cleanly and do not overflow.
- Suggestion: Stack the label above the select (`flex-col items-stretch`) on small screens so the label stays one line.
- Status: open

### Issue 11 -- Severity: nit
- File: packages/frontend/visual/shots/mobile/groups.png
- Description: Page header keeps `+ 新建用户组` on the same row as `用户组`; description stays on one line — no title collision. Inside the row, `授权` / `删除` sit mid-card to the right of the text block (`普通用户组 · 1 名成员` / grant chips). They do not overflow the phone width, but they visually overlap the metadata block instead of sitting under it like users.png.
- Suggestion: Same `flex-wrap` stack as users: identity block full width, actions on the next row (or a single overflow menu).
- Status: open
