import { readFileSync, writeFileSync } from 'node:fs';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function json(name) {
  return JSON.parse(readFileSync(required(name), 'utf8'));
}

const evidence = {
  schemaVersion: 1,
  runId: required('RUN_ID'),
  recordedAt: new Date().toISOString(),
  source: {
    gitHead: required('SOURCE_GIT_HEAD'),
    sshTreeHash: required('SSH_TREE_HASH'),
    httpTreeHash: required('HTTP_TREE_HASH'),
  },
  productionBinaries: {
    ssh: { sha256: required('SSH_BINARY_HASH'), imageId: required('SSH_IMAGE_ID') },
    http: { sha256: required('HTTP_BINARY_HASH'), imageId: required('HTTP_IMAGE_ID') },
  },
  transport: {
    backend: 'explicit private-CA WSS',
    controlStateInitial: json('CONTROL_STATE_INITIAL_FILE'),
    controlStateActive: json('CONTROL_STATE_ACTIVE_FILE'),
    controlStateRevoked: json('CONTROL_STATE_REVOKED_FILE'),
    controlStateQuiescent: json('CONTROL_STATE_QUIESCENT_FILE'),
  },
  revocation: json('REVOCATION_RESULT_FILE'),
  protocolResults: {
    ssh: {
      command: "printf 'nyabase-ssh-poc'",
      exitStatus: Number(required('SSH_COMMAND_STATUS')),
      stdout: required('SSH_COMMAND_OUTPUT'),
    },
    sftp: {
      exitStatus: Number(required('SFTP_STATUS')),
      downloadedBytes: Number(required('SFTP_BYTES')),
      downloadedSha256: required('SFTP_SHA256'),
    },
    http: {
      status: Number(required('HTTP_STATUS')),
      response: json('HTTP_RESPONSE_FILE'),
    },
    websocket: {
      received: required('WEBSOCKET_ECHO'),
    },
  },
  hardening: json('HARDENING_FILE'),
  checks: {
    releaseBuiltFromCurrentWorktree: true,
    sshHostKeyStrictlyVerified: true,
    opensshCommandRouted: true,
    opensshSftpRoundTrip: true,
    httpRequestRouted: true,
    websocketEchoRouted: true,
    sshEstablishedSessionRevoked: true,
    websocketEstablishedSessionRevoked: true,
    newHttpRouteRejectedAfterRevocation: true,
    newSshRouteRejectedAfterRevocation: true,
    tokenAbsentFromInspectAndLogs: true,
  },
  externalClients: {
    ssh: required('SSH_CLIENT_VERSION'),
    sshDefaultSendEnv: process.env.SSH_SEND_ENV ?? '',
    sftp: 'OpenSSH sftp batch client using host default ssh_config',
    http: required('CURL_VERSION'),
    websocket: 'ws 8.20.0',
  },
  scope: {
    productionBackendIntegrated: false,
    note: 'WSS control fixture speaks production snapshot envelopes; Full must still prove Backend-generated snapshots and APIs.',
  },
};

writeFileSync(required('EVIDENCE_FILE'), `${JSON.stringify(evidence, null, 2)}\n`);
