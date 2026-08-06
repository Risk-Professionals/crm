FROM postgres:17.7-bookworm

ARG AZCOPY_VERSION=10.32.4
ARG AZCOPY_SHA256=8f859a0dbbc117660c249fb3569694fc8a0f33b68701f5b2b92ccc001ee50784
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -fsSL "https://github.com/Azure/azure-storage-azcopy/releases/download/v${AZCOPY_VERSION}/azcopy_linux_amd64_${AZCOPY_VERSION}.tar.gz" -o /tmp/azcopy.tar.gz \
    && echo "${AZCOPY_SHA256}  /tmp/azcopy.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/azcopy.tar.gz -C /tmp \
    && install -m 0755 /tmp/azcopy_linux_amd64_*/azcopy /usr/local/bin/azcopy \
    && rm -rf /var/lib/apt/lists/* /tmp/azcopy*

COPY apps/postgres/entrypoint.sh /usr/local/bin/crm-postgres
COPY ops/postgres /app/ops/postgres
COPY ops/postgres-backup.sh /app/ops/postgres-backup.sh
RUN chmod 0755 /usr/local/bin/crm-postgres /app/ops/postgres/*.sh /app/ops/postgres-backup.sh

ENV PGDATA=/mnt/postgres/pgdata
ENTRYPOINT ["/usr/local/bin/crm-postgres"]
CMD ["server"]
