#!/usr/bin/env bash
set -euo pipefail

mode="${1:-server}"
if [[ $# -gt 0 ]]; then shift; fi
PGDATA="${PGDATA:-/mnt/postgres/pgdata}"
export PGDATA

if [[ "$(id -u)" == "0" ]]; then
  if [[ "$mode" == "init" ]]; then
    mkdir -p "$PGDATA"
    chown -R postgres:postgres "$(dirname "$PGDATA")"
  elif [[ "$mode" == "backup" && -n "${BACKUP_OUTPUT_DIR:-}" ]]; then
    mkdir -p "$BACKUP_OUTPUT_DIR"
    chown postgres:postgres "$BACKUP_OUTPUT_DIR"
  fi
  exec gosu postgres "$0" "$mode" "$@"
fi

require() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    printf '%s\n' "$name is required" >&2
    exit 1
  fi
}

case "$mode" in
  server)
    if [[ ! -f "$PGDATA/PG_VERSION" ]]; then
      printf '%s\n' "Refusing to start PostgreSQL because $PGDATA/PG_VERSION is absent" >&2
      exit 1
    fi
    exec docker-entrypoint.sh postgres "$@"
    ;;
  init)
    if [[ "${POSTGRES_INIT_CONFIRM:-}" != "initialize" ]]; then
      printf '%s\n' "POSTGRES_INIT_CONFIRM=initialize is required" >&2
      exit 1
    fi
    if [[ -e "$PGDATA/PG_VERSION" ]]; then
      printf '%s\n' "Refusing to initialize an existing PostgreSQL cluster" >&2
      exit 1
    fi
    require POSTGRES_ADMIN_PASSWORD
    require CRM_DATABASE_NAME
    require CRM_DATABASE_USER
    require CRM_DATABASE_PASSWORD
    require WORKFLOW_DATABASE_NAME
    require WORKFLOW_DATABASE_USER
    require WORKFLOW_DATABASE_PASSWORD
    mkdir -p "$PGDATA"
    chmod 0700 "$PGDATA"
    password_file="$(mktemp)"
    trap 'rm -f "$password_file"' EXIT
    printf '%s' "$POSTGRES_ADMIN_PASSWORD" >"$password_file"
    initdb --username=postgres --pwfile="$password_file" --auth-host=scram-sha-256 --auth-local=trust
    printf '%s\n' 'host all all 0.0.0.0/0 scram-sha-256' 'host all all ::/0 scram-sha-256' >>"$PGDATA/pg_hba.conf"
    pg_ctl -D "$PGDATA" -o "-c listen_addresses='' -c unix_socket_directories=/tmp" -w start
    trap 'pg_ctl -D "$PGDATA" -m fast -w stop >/dev/null 2>&1 || true; rm -f "$password_file"' EXIT
    psql --host=/tmp --username=postgres --dbname=postgres --set=ON_ERROR_STOP=1 \
      --set=role_name="$CRM_DATABASE_USER" --set=role_password="$CRM_DATABASE_PASSWORD" <<'SQL'
CREATE ROLE :"role_name" LOGIN PASSWORD :'role_password';
SQL
    createdb --host=/tmp --username=postgres --owner="$CRM_DATABASE_USER" "$CRM_DATABASE_NAME"
    psql --host=/tmp --username=postgres --dbname=postgres --set=ON_ERROR_STOP=1 \
      --set=role_name="$WORKFLOW_DATABASE_USER" --set=role_password="$WORKFLOW_DATABASE_PASSWORD" <<'SQL'
CREATE ROLE :"role_name" LOGIN PASSWORD :'role_password';
SQL
    createdb --host=/tmp --username=postgres --owner="$WORKFLOW_DATABASE_USER" "$WORKFLOW_DATABASE_NAME"
    pg_ctl -D "$PGDATA" -m fast -w stop
    trap - EXIT
    rm -f "$password_file"
    ;;
  backup)
    umask 0077
    require CRM_DATABASE_NAME
    require WORKFLOW_DATABASE_NAME
    upload=false
    if [[ -n "${BACKUP_OUTPUT_DIR:-}" ]]; then
      mkdir -p "$BACKUP_OUTPUT_DIR"
      root="$BACKUP_OUTPUT_DIR"
    else
      require CRM_BACKUP_STORAGE_ACCOUNT
      require CRM_BACKUP_CONTAINER
      root="$(mktemp -d)"
      upload=true
    fi
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    destination="$root/$stamp"
    temporary="$root/.${stamp}.partial"
    mkdir "$temporary"
    if [[ "$upload" == true ]]; then
      trap 'rm -rf "$root"' EXIT
    else
      trap 'rm -rf "$temporary"' EXIT
    fi
    pg_dumpall --globals-only | gzip -9 >"$temporary/globals.sql.gz"
    pg_dump --format=custom --compress=9 --file="$temporary/crm.dump" "$CRM_DATABASE_NAME"
    pg_dump --format=custom --compress=9 --file="$temporary/workflow.dump" "$WORKFLOW_DATABASE_NAME"
    (cd "$temporary" && sha256sum globals.sql.gz crm.dump workflow.dump >SHA256SUMS)
    mv "$temporary" "$destination"
    if [[ "$upload" == true ]]; then
      export AZCOPY_AUTO_LOGIN_TYPE=MSI
      if [[ -n "${AZURE_CLIENT_ID:-}" ]]; then
        export AZCOPY_MSI_CLIENT_ID="$AZURE_CLIENT_ID"
      fi
      remote="https://${CRM_BACKUP_STORAGE_ACCOUNT}.blob.core.windows.net/${CRM_BACKUP_CONTAINER}/${stamp}"
      data_objects=(globals.sql.gz crm.dump workflow.dump)
      for object in "${data_objects[@]}"; do
        azcopy copy "$destination/$object" "$remote/$object" --overwrite=false
      done
      if [[ "${CRM_BACKUP_REQUIRE_VERIFICATION:-false}" == "true" ]]; then
        listing="$(azcopy list "$remote" --machine-readable)"
        for object in "${data_objects[@]}"; do
          if ! grep -Fq "$object" <<<"$listing"; then
            printf '%s\n' "Remote backup is missing $object" >&2
            exit 1
          fi
        done
      fi
      azcopy copy "$destination/SHA256SUMS" "$remote/SHA256SUMS" --overwrite=false
      if [[ "${CRM_BACKUP_REQUIRE_VERIFICATION:-false}" == "true" ]]; then
        listing="$(azcopy list "$remote" --machine-readable)"
        for object in "${data_objects[@]}" SHA256SUMS; do
          if ! grep -Fq "$object" <<<"$listing"; then
            printf '%s\n' "Remote backup is missing $object" >&2
            exit 1
          fi
        done
      fi
      rm -rf "$root"
      trap - EXIT
      printf '%s\n' "$remote"
    else
      trap - EXIT
      printf '%s\n' "$destination"
    fi
    ;;
  *)
    printf '%s\n' "Unsupported mode: $mode" >&2
    exit 1
    ;;
esac
