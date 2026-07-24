FROM node:22-bookworm AS agent-builder

WORKDIR /src
RUN apt-get update \
    && apt-get install -y --no-install-recommends musl-tools \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/common/package.json packages/common/package.json
COPY packages/agent/package.json packages/agent/package.json
RUN pnpm install --frozen-lockfile --filter @nyabase/agent...

COPY packages/common packages/common
COPY packages/agent packages/agent
COPY tools/atomic-file-exchange tools/atomic-file-exchange
RUN pnpm --filter @nyabase/common build \
    && pnpm --filter @nyabase/agent build \
    && pnpm --filter @nyabase/agent deploy --prod /agent
RUN cp -a packages/agent/dist /agent/dist \
    && mkdir -p /agent/bin \
    && musl-gcc -static -O2 -Wall -Wextra -Werror \
      -o /agent/bin/nyabase-atomic-file-exchange \
      tools/atomic-file-exchange/atomic-file-exchange.c \
    && chmod 0755 /agent/bin/nyabase-atomic-file-exchange \
    && /agent/bin/nyabase-atomic-file-exchange --self-test /tmp \
    && mkdir -p /agent/node_modules/@nyabase/common \
    && cp -a packages/common/dist /agent/node_modules/@nyabase/common/dist

FROM node:22-bookworm

ENV container=docker \
    DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      ceph-common \
      dbus \
      docker.io \
      iproute2 \
      iputils-ping \
      iptables \
      kmod \
      nfs-common \
      procps \
      systemd \
      systemd-sysv \
      util-linux \
      xfsprogs \
    && rm -rf /var/lib/apt/lists/*

RUN test -x /usr/sbin/dockerd \
    && test ! -e /usr/bin/dockerd \
    && systemctl disable docker.service docker.socket containerd.service 2>/dev/null || true

RUN systemctl mask \
      console-getty.service \
      getty@.service \
      systemd-logind.service \
      systemd-remount-fs.service \
      systemd-udevd.service \
      systemd-udevd-control.socket \
      systemd-udevd-kernel.socket \
    || true

COPY --from=agent-builder /agent /opt/nyabase-agent
COPY e2e/topology/docker-dind/setup-node.sh /usr/local/libexec/nyabase-e2e/setup-node
COPY e2e/topology/docker-dind/cleanup-node.sh /usr/local/libexec/nyabase-e2e/cleanup-node
RUN chmod 0755 /usr/local/libexec/nyabase-e2e/setup-node \
    /usr/local/libexec/nyabase-e2e/cleanup-node \
    && test -x /opt/nyabase-agent/bin/nyabase-atomic-file-exchange \
    && /opt/nyabase-agent/bin/nyabase-atomic-file-exchange --self-test /etc \
    && rm -f /etc/machine-id /var/lib/dbus/machine-id \
    && touch /etc/machine-id

# Keep run-specific metadata after every stable dependency/source layer. A new
# run ID must produce a uniquely labelled image without invalidating the large
# Debian Docker/Ceph/NFS/systemd package layer.
ARG E2E_RUN_ID=unassigned
LABEL io.nyabase.e2e.component="cpu-node" \
      io.nyabase.e2e.run-id="${E2E_RUN_ID}"

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
