FROM debian:bookworm-slim

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
    bash \
    ceph-common \
    iproute2 \
    kmod \
    netbase \
    nfs-common \
    procps \
    util-linux \
  && rm -rf /var/lib/apt/lists/*

CMD ["sleep", "infinity"]
