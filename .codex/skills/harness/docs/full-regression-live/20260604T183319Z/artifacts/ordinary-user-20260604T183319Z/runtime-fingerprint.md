# Runtime Fingerprint — ordinary user lane

See full log: `../../logs/ordinary-user-20260604T183319Z/preflight.log`.

- Backend: `http://localhost:3001/api`, PID `2996829`, cwd `/root/nyabase/packages/backend`, argv `node -r tsconfig-paths/register dist/main.js`.
- Frontend: `http://localhost:5173`, PID `2996864`, cwd `/root/nyabase/packages/frontend`, Vite on `0.0.0.0:5173`.
- DB: `/root/nyabase/test/runtime/db/nyabase-test.db`, SQLite, size observed `3702784`, inode `2049:1054972`.
- DB counts during preflight: users `16`, servers `2`, images `12`, containers `40`, operations `126`.
- Online servers: `nyabase-test-cpu` and `nyabase-test-gpu`.
- Build freshness: backend dist newer than backend source touched in current session; frontend served via Vite source.
- Common-source guard: no generated `.js`, `.js.map`, `.d.ts`, or `.d.ts.map` files found under `packages/common/src`.
