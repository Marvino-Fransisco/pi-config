set -eu
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 --set reader_password="$MEMORY_READER_PASSWORD" <<'SQL'
CREATE ROLE memory_reader LOGIN PASSWORD :'reader_password';
GRANT CONNECT ON DATABASE pi_memory TO memory_reader;
GRANT USAGE ON SCHEMA public TO memory_reader;
GRANT SELECT ON projects, memories, memory_embeddings, memory_revisions TO memory_reader;
ALTER ROLE memory_reader SET default_transaction_read_only = on;
ALTER ROLE memory_reader SET statement_timeout = '3s';
REVOKE TEMPORARY ON DATABASE pi_memory FROM PUBLIC;
SQL
