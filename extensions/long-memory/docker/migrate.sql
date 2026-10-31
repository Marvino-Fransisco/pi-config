BEGIN;
CREATE TABLE IF NOT EXISTS memory_revisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  memory_id bigint NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  content text NOT NULL,
  source text NOT NULL,
  replaced_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_revisions_memory_id_idx ON memory_revisions(memory_id);
GRANT SELECT ON memory_revisions TO memory_reader;
COMMIT;
