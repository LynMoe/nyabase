FROM alpine:3.22 AS build

ARG DROPBEAR_VERSION=2026.91
ARG DROPBEAR_SOURCE_URL=https://matt.ucc.asn.au/dropbear/releases/dropbear-${DROPBEAR_VERSION}.tar.bz2
ARG DROPBEAR_TARBALL_SHA256=defa924475abf6bc1e74abc00173e46bfdc804bd47caafa14f5a4ef0cc76da34

RUN apk add --no-cache \
    bzip2 \
    curl \
    file \
    gcc \
    libc-dev \
    make \
    perl \
    zlib-dev

WORKDIR /build

RUN curl -fsSL "$DROPBEAR_SOURCE_URL" -o dropbear.tar.bz2 \
  && printf '%s  %s\n' "$DROPBEAR_TARBALL_SHA256" dropbear.tar.bz2 | sha256sum -c - \
  && tar -xjf dropbear.tar.bz2 --strip-components=1

RUN ./configure \
    --disable-zlib \
    --disable-utmp \
    --disable-utmpx \
    --disable-wtmp \
    --disable-wtmpx \
    --disable-lastlog \
    --disable-loginfunc \
    --enable-static \
    LDFLAGS='-static' \
  && make -j"$(nproc)" PROGRAMS=dropbear MULTI=0 SCPPROGRESS=0 \
  && mkdir -p /out \
  && strip dropbear \
  && cp dropbear /out/nyabase-dropbear-linux-x64 \
  && chmod 755 /out/nyabase-dropbear-linux-x64 \
  && sha256sum /out/nyabase-dropbear-linux-x64 \
    | awk '{print $1 "  nyabase-dropbear-linux-x64"}' \
    > /out/nyabase-dropbear-linux-x64.sha256 \
  && file /out/nyabase-dropbear-linux-x64 | tee /tmp/dropbear-file.txt \
  && grep -q 'statically linked' /tmp/dropbear-file.txt \
  && (/out/nyabase-dropbear-linux-x64 -h >/tmp/dropbear-help.txt 2>&1 || true) \
  && grep -q 'Dropbear' /tmp/dropbear-help.txt

FROM scratch AS artifact
COPY --from=build /out/nyabase-dropbear-linux-x64 /nyabase-dropbear-linux-x64
COPY --from=build /out/nyabase-dropbear-linux-x64.sha256 /nyabase-dropbear-linux-x64.sha256
