# nyabase atomic file exchange

Build the dependency-free Linux helper with:

```sh
musl-gcc -static -O2 -Wall -Wextra -Werror \
  -o nyabase-atomic-file-exchange atomic-file-exchange.c
```

CLI contract:

- `nyabase-atomic-file-exchange LEFT RIGHT` performs one verified
  `renameat2(RENAME_EXCHANGE)` between distinct absolute entries in the same
  canonical directory. There is no copy or rename fallback.
- `nyabase-atomic-file-exchange --self-test [SCRATCH_DIR]` creates two private
  files on that mount, performs the real syscall, verifies exchanged bytes,
  and cleans up.
- exit `0` means success; `64` is usage, `65` is an unsafe boundary, and `66`
  is a syscall or postcondition failure.

`pnpm build:agent-binary` produces both `dist/nyabase-agent` and
`dist/nyabase-atomic-file-exchange`. They are one release unit;
`deploy/install-agent.sh` refuses to install when either artifact is missing
and probes the helper on `/etc` before enabling the service.
