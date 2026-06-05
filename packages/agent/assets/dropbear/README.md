# Dropbear asset

This directory stores the static Linux x64 Dropbear server binary consumed by
source-mode agent runtime and `scripts/build-agent-binary.sh`.

Regenerate the asset from the archived Dockerfile:

```sh
docker buildx build \
  --platform linux/amd64 \
  -f packages/agent/assets/dropbear/Dockerfile \
  --output type=local,dest=packages/agent/assets/dropbear \
  packages/agent/assets/dropbear
chmod 755 packages/agent/assets/dropbear/nyabase-dropbear-linux-x64
(cd packages/agent/assets/dropbear && sha256sum -c nyabase-dropbear-linux-x64.sha256)
```

The Dockerfile downloads the official Dropbear source release from
`https://matt.ucc.asn.au/dropbear/releases/`, verifies the pinned source
tarball SHA256, and builds a static musl-linked `dropbear` server binary. To
update Dropbear, change `DROPBEAR_VERSION`, `DROPBEAR_SOURCE_URL`, and
`DROPBEAR_TARBALL_SHA256` in the Dockerfile using the official
`SHA256SUM.asc` release checksum file, then rerun the command above.
