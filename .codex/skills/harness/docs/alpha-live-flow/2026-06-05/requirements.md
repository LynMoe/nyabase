# Alpha live flow requirements

- Act as nyabase platform user persona Alpha.
- Use local test environment in /root/nyabase.
- Prefer command: source test/config/local.env; source test/runtime/murt/current.env; pnpm exec vitest run test/specs/live/multi-user-redteam-alpha.spec.ts --reporter=verbose
- Do not modify code.
- If runtime test resources are produced, clean per spec.
- Output Goal/Done/Evidence/Failed-blocked/Changed files.
