# Long-term memory

A separate Pi extension stores explicit global and per-checkout memories in PostgreSQL 18 with pgvector. It does not replace the file-backed task-memory extension. The agent must obtain interactive user confirmation before saving, updating, or deleting a memory. Searches are initiated by the user or the agent tool; memory is not automatically injected into every prompt. See [DIAGRAMS.md](docs/DIAGRAMS.md) for unit, integration, system, and end-to-end flows.

## Setup

Requires Docker Compose, Node.js, and a Gemini API key. From the repository root, install dependencies and make the extension available to Pi:

```sh
npm install
ln -s "$PWD/extensions/long-memory" ~/.pi/agent/extensions/long-memory
```

Create the local configuration file once without overwriting an existing one, restrict its permissions, and edit it privately:

```sh
if [ ! -e extensions/long-memory/.env ]; then cp extensions/long-memory/.env.example extensions/long-memory/.env; fi
chmod 600 extensions/long-memory/.env
${EDITOR:-nano} extensions/long-memory/.env
```

Fill in `MEMORY_DB_PASSWORD`, `MEMORY_READER_PASSWORD`, and `GEMINI_API_KEY`. Choose two different strong hexadecimal database passwords and retain them securely. The template uses port `55434`; change `MEMORY_DB_PORT` if necessary. This file is ignored by Git and excluded from the Docker build context; it still contains plaintext secrets readable by your user and processes running as that user.

Start the database using the same file:

```sh
docker compose --env-file extensions/long-memory/.env -f extensions/long-memory/docker/compose.yml up -d --build --wait
```

Reload Pi with `/reload`. The extension reads its `.env` automatically, regardless of the active project, and builds local connection URLs from the database passwords and port. Existing process environment variables take precedence; explicit `MEMORY_DATABASE_URL` and `MEMORY_READER_DATABASE_URL` override generated URLs. Docker Compose also gives shell variables precedence over `--env-file`, so conflicting exported values can cause connection errors. The extension rereads the file when configuration is needed, but database password changes in the file do not change PostgreSQL's existing role passwords.

The container uses `restart: unless-stopped`; it can start again when the Docker daemon starts. Docker Desktop itself must be running after login. If the database or Docker is stopped, Pi reports a connection error rather than starting it automatically.

The Docker named volume stores the database under `/var/lib/postgresql` inside the container. `docker compose down` keeps the volume; `down -v` deletes it. Do not delete an existing volume to fix a configuration issue. `schema.sql` and the reader role are initialized only for a new volume; later schema changes require an explicit migration. Use `pg_dump` for backups and test restoring them; backups contain private memory data.

## Usage

| Command | Effect |
| --- | --- |
| `/memory` | Open semantic-search TUI. Enter searches, Tab changes scope, arrows select, Enter opens details, Esc goes back or closes. |
| `/memory list [global\|project\|both]` | List up to 50 recent memories with previews and indexing status. |
| `/memory projects` | List up to 100 registered projects. |
| `/memory search [--global\|--project] <query>` | Search by semantic similarity; default is global plus current project. |
| `/memory show <id>` | Show a full memory in global or current-project scope. |
| `/memory save global\|project <text>` | Save with confirmation; command-created entries have kind `note`. |
| `/memory update <id> <text>` | Replace content with confirmation and regenerate its embedding. |
| `/memory delete <id>` | Delete with confirmation. |
| `/memory query <SELECT>` | Run a read-only SQL query, showing at most 100 rows and 30,000 characters. |

The `long_memory` agent tool additionally supports a memory kind such as `preference` or `decision`. Each write requires interactive confirmation; it is unavailable without a UI. Retrieved memories are untrusted data. IDs are restricted to global or current-project scope for normal show/update/delete operations. `/memory query` is an explicit read-only view of all three tables, including other projects; it uses the separate `memory_reader` database role, a read-only transaction, and a statement timeout. Protect its credentials and do not grant that role write privileges or privileged role memberships.

Project identity is the canonical Git checkout root; outside Git it is the canonical working directory. Separate worktrees therefore have separate memory. Moving a checkout changes its identity. Project records are created when a project-scoped memory is saved and remain after memories are deleted.

## Embeddings and privacy

Memory content and search queries are sent to Google's Gemini API. Free-tier terms may permit Google to use submitted content to improve its products. Do not save or search for passwords, API keys, or sensitive code unless you accept the applicable data handling. The extension does not automatically identify or redact secrets.

The model is `gemini-embedding-001`, with 768-dimensional vectors. Each request first calls Google's token-count endpoint and rejects inputs over 2,048 tokens; text is also limited to 8,000 characters. The endpoint currently requires the documented but deprecated top-level embedding configuration fields to honor the requested dimension; this must be rechecked if Google changes the API.

A memory is saved before its embedding is requested. If Google is unavailable, the memory remains readable and is marked `not indexed`, and the user is told why. Re-run `/memory update <id> <same text>` to retry indexing after fixing the issue. Search requires Google and reports failures rather than silently substituting keyword search.

## Verification

`npm test` runs local tests; the PostgreSQL integration test is skipped unless `LONG_MEMORY_TEST_DATABASE_URL` and `LONG_MEMORY_TEST_READER_URL` point to the same dedicated disposable database, named `pi_memory_test` or `pi_memory_test_*`, initialized with this schema and reader grants. That test truncates its tables and must never target a database with real memories. `npm run typecheck` checks the extension types.
