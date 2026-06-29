# SFTP server asset

This directory stores the static Linux x64 SFTP subsystem binary that the agent
injects into containers at `/usr/libexec/sftp-server`.

Regenerate the asset from the Rust source:

```sh
cargo build --release --target x86_64-unknown-linux-musl \
  --manifest-path tools/sftp-server/Cargo.toml
mkdir -p packages/agent/assets/sftp
cp tools/sftp-server/target/x86_64-unknown-linux-musl/release/nyabase-sftp-server \
  packages/agent/assets/sftp/nyabase-sftp-server-linux-x64
chmod 755 packages/agent/assets/sftp/nyabase-sftp-server-linux-x64
(cd packages/agent/assets/sftp && sha256sum nyabase-sftp-server-linux-x64 \
  > nyabase-sftp-server-linux-x64.sha256)
```
