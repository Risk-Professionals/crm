# CRM PostgreSQL container

The image is built from the repository root:

```sh
docker build -f apps/postgres/Dockerfile -t crm-postgres .
```

The default `server` mode requires `PGDATA/PG_VERSION` and refuses an empty or
wrong mount. It never initializes storage.

The one-time init Job runs `init` with an NFS mount at `/mnt/postgres` and these
values:

```text
POSTGRES_INIT_CONFIRM=initialize
POSTGRES_ADMIN_PASSWORD
CRM_DATABASE_NAME
CRM_DATABASE_USER
CRM_DATABASE_PASSWORD
WORKFLOW_DATABASE_NAME
WORKFLOW_DATABASE_USER
WORKFLOW_DATABASE_PASSWORD
```

Initialization refuses an existing cluster. It creates the CRM and Workflow
roles and databases separately and leaves host authentication on
`scram-sha-256`.

The backup Job runs `backup` with PostgreSQL client connection variables and
either a local output directory or a managed-identity Azure Blob destination:

```text
CRM_DATABASE_NAME
WORKFLOW_DATABASE_NAME
BACKUP_OUTPUT_DIR=/mnt/backups
```

```text
CRM_DATABASE_NAME
WORKFLOW_DATABASE_NAME
CRM_BACKUP_STORAGE_ACCOUNT
CRM_BACKUP_CONTAINER
AZURE_CLIENT_ID
```

Backup mode uses a restrictive `0077` umask. Each successful run produces
compressed globals, custom-format CRM and Workflow dumps, and SHA-256 checksums.
Local output is atomically published under a UTC-named directory. ACA Jobs use
the image's pinned AzCopy installation and the job's user-assigned identity to
upload the data objects before publishing `SHA256SUMS` as the completion marker.
Set `CRM_BACKUP_REQUIRE_VERIFICATION=true` to list the remote generation and
require every expected object before the job succeeds.

The image exposes `/app/ops/postgres-backup.sh` for scheduled backup jobs and
`/app/ops/postgres/start.sh`, `init.sh`, and `backup.sh` for the entrypoint modes.
