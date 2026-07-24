FROM quay.io/ceph/ceph:v19.2.3@sha256:af0c5903e901e329adabe219dfc8d0c3efc1f05102a753902f33ee16c26b6cee

COPY entrypoint.sh /usr/local/sbin/nyabase-ceph-poc
RUN chmod 0755 /usr/local/sbin/nyabase-ceph-poc

ENTRYPOINT ["/usr/local/sbin/nyabase-ceph-poc"]
