FROM debian:trixie-slim@sha256:020c0d20b9880058cbe785a9db107156c3c75c2ac944a6aa7ab59f2add76a7bd

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
    nfs-ganesha \
    nfs-ganesha-vfs \
    rpcbind \
    tini \
  && rm -rf /var/lib/apt/lists/*

COPY ganesha.conf.in /etc/ganesha/ganesha.conf.in
COPY entrypoint.sh /usr/local/sbin/nyabase-ganesha-fixture
RUN chmod 0755 /usr/local/sbin/nyabase-ganesha-fixture

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/sbin/nyabase-ganesha-fixture"]
