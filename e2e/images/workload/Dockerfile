FROM alpine:3.20

RUN adduser -D -u 10001 workload
USER workload
WORKDIR /work
EXPOSE 8080
CMD ["sh", "-ec", "printf 'nyabase real cpu e2e\\n' > marker && exec tail -f /dev/null"]
