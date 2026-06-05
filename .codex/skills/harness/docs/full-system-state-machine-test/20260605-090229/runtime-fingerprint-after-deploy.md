# Runtime fingerprint after reset/register/deploy

Generated: 2026-06-05T09:13:25+08:00

## Local service metadata
```json
{
  "startedAt": "2026-06-05T01:08:20.750Z",
  "frontendUrl": "http://localhost:5173",
  "backendUrl": "http://localhost:3001",
  "victoriaMetricsUrl": "http://127.0.0.1:8428",
  "dbPath": "/root/nyabase/test/runtime/db/nyabase-test.db",
  "backendPid": "3137498",
  "frontendPid": "3137573",
  "backendLog": "/root/nyabase/test/runtime/logs/backend.log",
  "frontendLog": "/root/nyabase/test/runtime/logs/frontend.log"
}
```

## Agent metadata (non-secret)
```json
{
  "generatedAt": "2026-06-05T01:08:27.335Z",
  "backendUrl": "http://localhost:3001",
  "agents": [
    {
      "key": "cpu",
      "name": "nyabase-test-cpu",
      "serverId": "c5134298-fda7-4369-ab51-e0c7065d7058",
      "ssh": "root@10.8.96.91",
      "sudo": false,
      "isGpuServer": false,
      "parentIface": "eth0",
      "ipCidr": "10.8.109.0/24",
      "gateway": "10.8.0.1",
      "reservedIps": [
        "10.8.96.91"
      ],
      "dockerRoot": "/data/nyabase-docker",
      "status": "unknown",
      "configPath": "/root/nyabase/test/runtime/agents/configs/cpu.yaml"
    },
    {
      "key": "gpu",
      "name": "nyabase-test-gpu",
      "serverId": "88ff8efa-2fbd-4e16-b189-2ab949d26ade",
      "ssh": "lyn@10.8.1.12",
      "sudo": true,
      "isGpuServer": true,
      "parentIface": "bond0",
      "ipCidr": "10.8.110.0/24",
      "gateway": "10.8.0.1",
      "reservedIps": [
        "10.8.1.12"
      ],
      "dockerRoot": "/data0/nbTest/nyabase-docker-pquota",
      "status": "unknown",
      "configPath": "/root/nyabase/test/runtime/agents/configs/gpu.yaml"
    }
  ]
}
```

## Local PID status
```
UID          PID    PPID  C STIME TTY          TIME CMD
root     3137498       1 13 09:08 ?        00:00:40 node -r tsconfig-paths/register dist/main.js
UID          PID    PPID  C STIME TTY          TIME CMD
root     3137573       1  0 09:08 ?        00:00:00 node /usr/bin/pnpm exec vite --port 5173 --host 0.0.0.0 --strictPort
```

## Remote services
```
### root@10.8.96.91
nyabase-test-1
active
active
-rw------- 1 root root      388 Jun  5 09:08 /etc/nyabase/agent.yaml
-rwxr-xr-x 1 root root 76213465 Jun  5 09:08 /usr/local/bin/nyabase-agent
Jun 05 09:13:02 nyabase-test-1 nyabase-agent[2632033]: [WS] Disconnected: 4000 Replaced by new connection
Jun 05 09:13:02 nyabase-test-1 nyabase-agent[2632033]: [Agent] Disconnected from backend
Jun 05 09:13:03 nyabase-test-1 nyabase-agent[2632033]: [WS] Connecting to ws://10.8.96.92:3001/ws/agent...
Jun 05 09:13:03 nyabase-test-1 nyabase-agent[2632033]: [WS] Connected
### lyn@10.8.1.12
aya-1
active
active
-rw------- 1 lyn lyn      403 Jun  5 01:07 /etc/nyabase/agent.yaml
-rwxr-xr-x 1 lyn lyn 76213465 Jun  5 01:07 /usr/local/bin/nyabase-agent
Jun 05 01:07:36 aya-1 nyabase-agent[378696]: [Agent] nyabase-docker daemon is running
Jun 05 01:07:36 aya-1 nyabase-agent[378696]: [WS] Connecting to ws://10.8.96.92:3001/ws/agent...
Jun 05 01:07:36 aya-1 nyabase-agent[378696]: [Agent] Started, connecting to ws://10.8.96.92:3001/ws/agent
Jun 05 01:07:36 aya-1 nyabase-agent[378696]: [WS] Connected
```

## Backend server summary
```json
[
  {
    "id": "c5134298-fda7-4369-ab51-e0c7065d7058",
    "name": "nyabase-test-cpu",
    "status": "online",
    "isGpuServer": false,
    "lastSeenAt": "2026-06-05T01:13:25.047Z",
    "dockerDaemon": null
  },
  {
    "id": "88ff8efa-2fbd-4e16-b189-2ab949d26ade",
    "name": "nyabase-test-gpu",
    "status": "online",
    "isGpuServer": true,
    "lastSeenAt": "2026-06-05T01:13:24.328Z",
    "dockerDaemon": null
  }
]
```
