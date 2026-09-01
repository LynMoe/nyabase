## Summary

Reviewed 15 of 16 requested mobile dialog shots at 390×844 (PNGs are 780×1688 at `deviceScaleFactor: 2`). `dialog-ssh-disconnect.png` does not exist: capture skipped because `/ssh-proxy` crashed before the confirm could open.

**Passing checks**

- No dialog is wider than the viewport. `DialogContent` / `AlertDialogContent` use `w-[calc(100%-2rem)]`, which measures as **16 CSS px gutters** on left and right. That is not “no side gutters.”
- Compact form dialogs (`create-user`, `create-group`, `http-binding`) keep fields and stacked 创建/保存 + 取消 buttons inside the card.
- Confirm dialogs that rendered (`disable-user`, `delete-volume`, `stop-container`, `delete-ssh-key`) are readable: title, body, and full-width stacked buttons all fit with no overflow.
- Close (×) does **not** overlap the title in these shots. Longest title is `管理 平台管理员 的授权`; there is still a gap to `right-4`.

**Failing checks**

- Three long dialogs hit `max-h-[90vh]` (~760 CSS px, ~42 px overlay remaining above/below) and hide primary actions on first paint. `overflow-y-auto` is on the whole panel, there is no sticky footer, and mobile overlay scrollbars are invisible — they look like they do not scroll.
- Audit “dialog” is an ErrorBoundary page, not a dialog.
- All dialogs are `fixed; top: 50%; translateY(-50%)` with no `visualViewport` / `dvh` handling. Remaining space below even compact forms is 80–192 px; a typical iOS keyboard is ~290 px.

## Issues

### Issue 1 -- Severity: bug
- File: packages/frontend/visual/shots/mobile/dialog-audit-detail.png
- Description: Opening 审计详情 does not show a dialog. The shot is a full-page ErrorBoundary: “页面出错了” / `Cannot read properties of undefined (reading 'length')`. The 查看 click reached the page, then `AuditDetailDialog` crashed on `log.related.length` while `related` is undefined. Visual mock `auditLog` in `capture.mjs` also omits `related`, `actorSnapshot`, and `targetSnapshot`, so the same crash happens against the visual API.
- Suggestion: Guard with `log.related?.length`, default `related` to `[]`, and make the visual mock match `AuditLogDto`. Keep the error inside the dialog instead of taking down the page.
- Status: open

### Issue 2 -- Severity: bug
- File: packages/frontend/visual/shots/mobile/dialog-user-grants.png
- Description: Grant dialog is too tall for 390×844. The panel is maxed at ~90vh. First paint ends on the server-grant card: CPU/内存/磁盘 fields, “保存后到期时间：不设期限”, then the top ~8 px of a clipped light-blue “保存服务器授权” button. Storage-pool and shared-backend cards never appear. There is no visible scrollbar or “more below” affordance. Footer is not sticky; the action is not tappable as drawn.
- Suggestion: Make `DialogContent` a column (`flex max-h-[min(90dvh,100svh)]`) with a sticky/shrink-0 header, `min-h-0 flex-1 overflow-y-auto` body, and a sticky footer. Or open grants as a full-screen sheet with a visible scroll shadow. Do not put `overflow-y-auto` on the entire dialog including the clipped button.
- Status: open

### Issue 3 -- Severity: bug
- File: packages/frontend/visual/shots/mobile/dialog-create-container.png
- Description: Same 90vh clip. Last visible rows are GPU = 无 and “请先选择服务器”. 期望电源状态 and `DialogFooter` (创建容器 / 取消) are below the fold. A user who does not know to swipe the unmarked panel cannot submit. Fields themselves do not overflow horizontally.
- Suggestion: Same sticky-header / scrolling-body / sticky-footer pattern as Issue 2. On a 390-wide viewport, collapse `sm:grid-cols-2` / `sm:grid-cols-3` is already single-column; the problem is vertical stacking of every field plus footer inside one scrolling `max-h-[90vh]` box.
- Status: open

### Issue 4 -- Severity: bug
- File: packages/frontend/visual/shots/mobile/dialog-server-onboarding.png
- Description: Onboarding dialog is also 90vh-capped. Last visible control is “证书 pin（SHA-256）”. Bearer token and the 登记服务器 / 取消 footer are off-screen with no scroll hint. The metrics endpoint value/placeholder is clipped inside the input: `https://node.example:9100/n` instead of `.../metrics`.
- Suggestion: Same dialog layout as Issue 2. Optionally shrink the optional node-exporter block on small viewports, or start it collapsed. Single-line `font-mono` inputs should use `text-overflow` plus enough horizontal padding that a long URL is obviously truncated, not cut mid-character at the border.
- Status: open

### Issue 5 -- Severity: bug
- File: packages/frontend/visual/shots/mobile/dialog-ssh-disconnect.png (missing; page shot packages/frontend/visual/shots/mobile/ssh-proxy.png)
- Description: Shot was skipped (`manifest.json` `"skipped": true`). `/ssh-proxy` itself is an ErrorBoundary: “页面出错了” / `Cannot read properties of undefined (reading 'map')`. The 断开全部 trigger never renders, so the confirm dialog cannot be reviewed. Desktop capture of this dialog was also skipped.
- Suggestion: Fix the SSH status/connections render path (do not `.map` an undefined list). After the page renders, re-capture `dialog-ssh-disconnect`.
- Status: open

### Issue 6 -- Severity: suggestion
- File: packages/frontend/visual/shots/mobile/dialog-create-user.png
- Description: Keyboard was not opened, but remaining overlay space is too small for one. Measured CSS px below the dialog card: grants / create-container / onboarding ~42 px; ip-pool ~45 px; create-image ~80 px; domain-pool ~84 px; create-volume ~110 px; http-binding ~178 px; create-user ~192 px; create-group ~243 px. Confirm cards have ~307 px, still tight vs a ~290 px iOS keyboard. Dialogs are centered on the layout viewport (`top-[50%] translate-y-[-50%]`) with no `interactive-widget` / `visualViewport` inset, so focusing 用户名 / 名称 / 通配域名 will cover stacked 保存/取消.
- Suggestion: Pin open dialogs to the visual viewport: `top: max(1rem, env(safe-area-inset-top))` (or `dvh` box) and shrink height as the keyboard comes up. Keep the focused field and the footer in the unobscured region. Add `max-h` + internal scroll to dialogs that currently omit it (`create-user`, `create-group`, `create-volume`, `create-image`, `http-binding`).
- Status: open

### Issue 7 -- Severity: suggestion
- File: packages/frontend/visual/shots/mobile/dialog-ip-pool.png
- Description: 创建 IP 池 *does* show 保存 / 取消, but the card is 754 CSS px tall with only ~45 px of overlay left. The long description plus five fields plus the 绑定服务器 block leave no slack for a validation error or a second server checkbox. `lab-node-a` is printed twice (display name + slug) on one row.
- Suggestion: Shorten the description on mobile, or move help into a collapsed note. Hide slug when it equals `name`. Keep the footer sticky so an extra line of error text cannot push 保存 off-screen.
- Status: open

### Issue 8 -- Severity: suggestion
- File: packages/frontend/visual/shots/mobile/dialog-domain-pool.png
- Description: Footer is visible, but two `min-h-28` PEM textareas force the dialog to ~676 CSS px. Enabling HTTPS and pasting real PEM will grow the areas; with only ~84 px remaining and no sticky footer, 保存 can fall off the first screen. Keyboard on 通配域名 would cover both PEM boxes and the footer.
- Suggestion: Cap PEM textareas (`max-h-32 overflow-y-auto`) on small viewports; sticky footer; same keyboard inset as Issue 6.
- Status: open

### Issue 9 -- Severity: suggestion
- File: packages/frontend/visual/shots/mobile/dialog-create-image.png
- Description: 添加镜像 currently fits (buttons visible, ~80 px remaining) but `DialogContent` has **no** `max-h` / `overflow-y-auto`. A validation message or an extra field would overflow the viewport with nowhere to scroll. Same for `dialog-create-volume.png` (fits at ~624 CSS px / 110 px remaining, also no max-height).
- Suggestion: Put max-height + scrolling body + sticky footer on the shared `DialogContent` primitive instead of opting in per page.
- Status: open

### Issue 10 -- Severity: nit
- File: packages/frontend/visual/shots/mobile/dialog-user-grants.png
- Description: Native `datetime-local` renders `mm/dd/yyyy, --:-- --` despite `locale: 'zh-CN'`. The value fits the field (no horizontal overflow) but is the wrong date/time convention for a Chinese admin UI, and the calendar icon crowds the placeholder.
- Suggestion: Format with `zh-CN` (or a custom picker). Leave empty as a real placeholder (“不设期限”) instead of the English mask.
- Status: open

### Issue 11 -- Severity: nit
- File: packages/frontend/visual/shots/mobile/dialog-create-user.png
- Description: Header is `text-center` on mobile while × is `absolute right-4 top-4`. Titles are not colliding, but they sit optically left of center under the close control. Not a clip; just slightly unbalanced.
- Suggestion: `DialogHeader` `pr-8` (and keep title centered), or left-align titles on small screens so they never compete with ×.
- Status: open
