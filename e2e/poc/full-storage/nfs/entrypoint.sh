#!/bin/sh
set -eu

umask 077
: "${NFS_CLIENT_CIDR:?NFS_CLIENT_CIDR is required}"

case "$NFS_CLIENT_CIDR" in
  *[!0-9./]*)
    echo "invalid NFS_CLIENT_CIDR" >&2
    exit 2
    ;;
esac

install -d -m 0755 /run/ganesha /run/rpcbind /var/lib/nfs/ganesha /srv/export
sed "s|@CLIENT_CIDR@|${NFS_CLIENT_CIDR}|g" \
  /etc/ganesha/ganesha.conf.in > /etc/ganesha/ganesha.conf
chmod 0600 /etc/ganesha/ganesha.conf

rpcbind -w
exec /usr/bin/ganesha.nfsd -F -L /proc/1/fd/1 -f /etc/ganesha/ganesha.conf
