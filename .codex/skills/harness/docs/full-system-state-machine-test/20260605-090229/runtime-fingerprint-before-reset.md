# Runtime fingerprint before reset

Generated: 2026-06-05T09:07:11+08:00

## Local service metadata

```json
{
  "startedAt": "2026-06-04T21:34:07.491Z",
  "frontendUrl": "http://localhost:5173",
  "backendUrl": "http://localhost:3001",
  "victoriaMetricsUrl": "http://127.0.0.1:8428",
  "dbPath": "/root/nyabase/test/runtime/db/nyabase-test.db",
  "backendPid": "3100414",
  "frontendPid": "3100435",
  "backendLog": "/root/nyabase/test/runtime/logs/backend.log",
  "frontendLog": "/root/nyabase/test/runtime/logs/frontend.log"
}
```

## PID status

```
UID          PID    PPID  C STIME TTY          TIME CMD
root     3100414       1  1 05:34 ?        00:02:52 node -r tsconfig-paths/register dist/main.js
UID          PID    PPID  C STIME TTY          TIME CMD
root     3100435       1  0 05:34 ?        00:00:00 node /usr/bin/pnpm exec vite --port 5173 --host 0.0.0.0 --strictPort
```

## Endpoint probe

```
backend_auth_status=401
frontend_status=200
vm_status=200
```
