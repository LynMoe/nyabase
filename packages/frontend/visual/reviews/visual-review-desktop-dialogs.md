## Summary

Reviewed 15 of 16 requested 1280×800 desktop dialog screenshots under `packages/frontend/visual/shots/desktop/`. `dialog-ssh-disconnect.png` is **missing** from the shots directory (no file to inspect).

Most form and confirm dialogs look healthy on this viewport: they stay inside the frame, keep side margins, keep fields inside the card, and keep footer actions on one right-aligned row. Close (X) never collides with the title. The overlay is the expected full-viewport dim (sidebar + cert banner included).

Two real problems stand out:

1. **User grants (`max-w-5xl`)** overflows the 800px viewport at the bottom. `存储池授权` is clipped; `共享存储授权` is not visible. Side margins are tight and the panel covers the sidebar.
2. **Audit detail** never renders a dialog. The page error boundary is shown instead (`Cannot read properties of undefined (reading 'length')`).

Confirm dialogs (disable user, delete volume, stop container, delete SSH key) are a consistent `max-w-lg` width — neither oversized nor tiny. The only confirm nit is an awkward last-line wrap on delete-volume.

**Looks good (no layout issues found):** `dialog-create-user.png`, `dialog-create-group.png`, `dialog-create-container.png`, `dialog-create-volume.png`, `dialog-create-image.png`, `dialog-ip-pool.png`, `dialog-http-binding.png`, `dialog-domain-pool.png`, `dialog-disable-user.png`, `dialog-stop-container.png`, `dialog-delete-ssh-key.png`.

## Issues

### Issue 1 -- Severity: bug
- File: dialog-user-grants.png
- Description: The grants dialog (`max-w-5xl max-h-[90vh] overflow-y-auto`) overflows the 800px viewport at the bottom. The white panel has no visible bottom rounded corner or bottom padding; the last painted row is the `存储池授权` card header, cut off mid-section. `共享存储授权` never appears. There is no visible scrollbar, so `max-h-[90vh]` / `overflow-y-auto` is not taking effect in this shot. Combined with `top-1/2 -translate-y-1/2`, a taller-than-viewport panel is clipped by the window rather than contained. The first card (`服务器授权`) already consumes almost the full height, so the remaining two grant types are unreachable in the initial view.
- Suggestion: Make `DialogContent` a column flex/grid with `max-h-[min(90vh,calc(100vh-2rem))]`, `min-h-0`, and an inner `overflow-y-auto` body so the chrome (title + close) stays put and the three cards scroll inside. Pin a sticky footer or keep per-card save actions but ensure all three sections are reachable. Verify a scrollbar appears when content exceeds 90vh.
- Status: open

### Issue 2 -- Severity: suggestion
- File: dialog-user-grants.png
- Description: On 1280×800, `max-w-5xl` (1024px) centered on the full viewport leaves only ~128px per side. The left edge sits over the 224px sidebar; nav labels are unreadable under the overlay. Horizontal breathing room is much tighter than every other dialog in this set. The three stacked grant cards plus expiry / GPU / quota fields make the surface feel cramped even before the bottom clip.
- Suggestion: Either cap width lower (e.g. `max-w-3xl` / `max-w-4xl`) so the sidebar stays in the dimmed margin, or present the three grant types as tabs / accordion so a single card fits the 800px height without going edge-to-edge.
- Status: open

### Issue 3 -- Severity: suggestion
- File: dialog-user-grants.png
- Description: In the `服务器` / `GPU 授权` two-column row, the left column is a single labeled select. The right column has an outer `GPU 授权` label **and** GpuPicker’s inner `GPU` label, so the GPU dropdown sits a full label-row lower than `服务器`. Helper text `请先选择服务器` then stretches the right column further. The row looks unbalanced and wastes vertical space in an already overflowing dialog.
- Suggestion: Drop the outer `GPU 授权` label (or the inner GpuPicker `GPU` label) so both controls share one baseline. Keep the helper text, but don’t stack two titles.
- Status: open

### Issue 4 -- Severity: nit
- File: dialog-user-grants.png
- Description: The expiry control is a native `datetime-local` showing the English placeholder `mm/dd/yyyy, --:-- --` (with `mm` highlighted) on an otherwise zh-CN surface. The field itself does not overflow, but the locale mismatch is visually noisy and the placeholder is hard to parse.
- Suggestion: Use a zh-CN formatted datetime picker, or a date + time pair with Chinese placeholders (`年/月/日`, `时:分`). Empty state should read as “不设期限”, matching the label.
- Status: open

### Issue 5 -- Severity: bug
- File: dialog-audit-detail.png
- Description: No audit-detail dialog is shown. The main canvas is an error-boundary card: `页面出错了` / `抱歉，页面渲染时发生异常。` with `Cannot read properties of undefined (reading 'length')`. There is no modal overlay, no `审计详情` chrome, and no JSON / snapshot layout to review. Footer of the error card (`重试` / `刷新页面`) is fine, but this is not the dialog under test. Likely `log.related.length` when `related` is missing on the list-row fallback (`detailLog ?? selectedLog`) before the detail query resolves.
- Suggestion: Guard `related` (`log.related?.length`), and do not render the detail body from a list row that omits `related` / snapshots. Show the dialog shell with a loading state until the detail query succeeds, so a missing field cannot take down the page.
- Status: open

### Issue 6 -- Severity: suggestion
- File: dialog-server-onboarding.png
- Description: The onboarding dialog does **not** overflow — rounded corners, footer (`取消` / `登记服务器`), and close (X) are all visible — but it nearly fills the 800px height. Only a thin strip of overlay remains above (under the cert banner) and below. `DNS（逗号分隔）` occupies only the left half of a two-column grid, leaving a large empty right cell. The optional node-exporter block plus three extra fields drive the height. Footer lives inside the same `overflow-y-auto` surface, so it would scroll away if any field wrapped or the optional block grew.
- Suggestion: Keep `max-h-[90vh]` but scroll only the form body and pin `DialogFooter`. Collapse or defer the optional node-exporter / pin / token fields. Let DNS span full width (or pair it with a related field) so the left column is not a lone half-width control.
- Status: open

### Issue 7 -- Severity: nit
- File: dialog-delete-volume.png
- Description: Confirm width matches the other `max-w-lg` confirms and is not too wide/narrow, but the description wraps poorly: `请先卸载后再` on one line and a stranded `试。` on the next. Disable-user / stop-container / delete-SSH-key descriptions fit a single line at the same width.
- Suggestion: Slightly increase confirm max-width for long copy, or break the sentence (`请先卸载后再试。` on its own line) so a one-character widow does not sit alone.
- Status: open

### Issue 8 -- Severity: bug
- File: dialog-ssh-disconnect.png
- Description: File does not exist at `packages/frontend/visual/shots/desktop/dialog-ssh-disconnect.png`. Cannot review overlay, width, footer wrapping, or title/close spacing. The in-app confirm (`断开所有 SSH 代理会话？` on the SSH proxy page) was not captured.
- Suggestion: Re-run the desktop visual shot for SSH disconnect-all and add the PNG to this folder, then re-review against the same checklist.
- Status: open
