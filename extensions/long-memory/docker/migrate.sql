\if :{?app_password}
\else
\echo 'Pass -v app_password=... (MEMORY_APP_PASSWORD)'
\quit 3
\endif
BEGIN;
CREATE TABLE IF NOT EXISTS memory_revisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  memory_id bigint NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  content text NOT NULL,
  source text NOT NULL,
  replaced_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_revisions_memory_id_idx ON memory_revisions(memory_id);
ALTER TABLE memories ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS memories_content_hash_idx ON memories(project_id, md5(content));
CREATE INDEX IF NOT EXISTS memories_deleted_at_idx ON memories(deleted_at) WHERE deleted_at IS NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'memory_app') THEN CREATE ROLE memory_app LOGIN; END IF;
END $$;
ALTER ROLE memory_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'app_password';
ALTER ROLE memory_app SET statement_timeout = '5s';
GRANT CONNECT ON DATABASE :"DBNAME" TO memory_app;
GRANT USAGE ON SCHEMA public TO memory_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON projects, memories, memory_embeddings, memory_revisions TO memory_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO memory_app;
GRANT SELECT ON projects, memories, memory_embeddings, memory_revisions TO memory_reader;
COMMIT;
