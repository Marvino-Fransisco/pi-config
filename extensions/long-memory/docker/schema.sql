CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE projects (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  path text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memories (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id bigint REFERENCES projects(id) ON DELETE RESTRICT,
  kind text NOT NULL,
  content text NOT NULL CHECK (length(content) > 0),
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE memory_embeddings (
  memory_id bigint PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  model text NOT NULL,
  embedding vector(768) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX memories_project_id_idx ON memories(project_id);
CREATE INDEX memories_content_hash_idx ON memories(project_id, md5(content));
CREATE INDEX memories_deleted_at_idx ON memories(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE memory_revisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  memory_id bigint NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  content text NOT NULL,
  source text NOT NULL,
  replaced_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX memory_revisions_memory_id_idx ON memory_revisions(memory_id);
