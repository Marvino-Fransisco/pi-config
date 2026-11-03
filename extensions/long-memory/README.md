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

Fill in `MEMORY_DB_PASSWORD`, `MEMORY_APP_PASSWORD`, `MEMORY_READER_PASSWORD`, and `GEMINI_API_KEY`. Choose three different strong hexadecimal database passwords and retain them securely. The template uses port `55434`; change `MEMORY_DB_PORT` if necessary. This file is ignored by Git and excluded from the Docker build context; it still contains plaintext secrets readable by your user and processes running as that user.

Start the database using the same file:

```sh
docker compose --env-file extensions/long-memory/.env -f extensions/long-memory/docker/compose.yml up -d --build --wait
```

Reload Pi with `/reload`. The extension reads its `.env` automatically, regardless of the active project, and builds local connection URLs from the database passwords and port. Existing process environment variables take precedence; explicit `MEMORY_DATABASE_URL` and `MEMORY_READER_DATABASE_URL` override generated URLs. Docker Compose also gives shell variables precedence over `--env-file`, so conflicting exported values can cause connection errors. The extension rereads the file when configuration is needed, but database password changes in the file do not change PostgreSQL's existing role passwords.

Normal operations use the restricted `memory_app` role. Automatic backups run at session start when the latest backup is at least 24 hours old; `MEMORY_BACKUP=off` disables them and `MEMORY_BACKUP_KEEP` controls retention (default 7). Backups in `~/.pi/agent/long-memory/backups` contain private data; test restoration separately.

The container uses `restart: unless-stopped`; it can start again when the Docker daemon starts. Docker Desktop itself must be running after login. If the database or Docker is stopped, Pi reports a connection error rather than starting it automatically.

For an existing database, back it up with `pg_dump` before applying the additive, repeatable migration. Set `MEMORY_APP_PASSWORD` and rebuild/start the container as above, then run:

```sh
docker compose --env-file extensions/long-memory/.env -f extensions/long-memory/docker/compose.yml exec -T postgres sh -c 'psql -U memory_owner -d pi_memory -v ON_ERROR_STOP=1 -v app_password="$MEMORY_APP_PASSWORD"' < extensions/long-memory/docker/migrate.sql
```

New databases are initialized with the current schema and roles. The migration adds revision storage, soft deletion, indexes and restricted role grants; it does not rewrite or delete memories.

The Docker named volume stores the database under `/var/lib/postgresql` inside the container. `docker compose down` keeps the volume; `down -v` deletes it. Do not delete an existing volume to fix a configuration issue. `schema.sql` and the reader role are initialized only for a new volume; later schema changes require an explicit migration. Use `pg_dump` for backups and test restoring them; backups contain private memory data.

## Usage

| Command | Effect |
| --- | --- |
| `/memory` | Open the statistics dashboard. Tab cycles STATS, SEARCH, LIST, TRASH, DEBUG and SQL; Shift+Tab reverses. Ctrl+S changes scope outside SQL. Arrows select or scroll; Enter runs a query or opens a memory. LIST filters by kind; Ctrl+N/P pages LIST and TRASH. In detail, Ctrl+D asks to trash or permanently purge, Ctrl+H shows history, and Ctrl+R restores from trash. Confirm deletion with `y` or cancel with `n`. STATS offers Ctrl+R to reindex. SQL supports Ctrl+Left/Right to pan. Backspace returns from detail; Esc closes the panel. `/memory` toggles the panel. Narrow terminals use a full-screen fallback. |
| `/memory list [global\|project\|both] [kind\|-] [offset]` | List 50 recent memories per page with previews and indexing status. Use `-` for all kinds, e.g. `/memory list both - 50`. |
| `/memory projects` | List up to 100 registered projects. |
| `/memory search [--global\|--project] <query>` | Search for up to five memories by semantic similarity; default is global plus current project. |
| `/memory show <id>` | Show a full memory in global or current-project scope. |
| `/memory stats [global\|project\|both]` | Counts by scope/kind, indexed versus unindexed, embedding model and dimensions. |
| `/memory debug [--global\|--project] <query>` | Run the same retrieval as search and show scope/project, strategy, candidate/index counts, elapsed time, selected IDs and similarity scores. The query is sent to Google. |
| `/memory history <id>` | Show the latest 50 replaced versions, newest first. |
| `/memory save global\|project <text>` | Save with confirmation; command-created entries have kind `note`. |
| `/memory update <id> <text>` | Replace content with confirmation, retain the old version, and regenerate its embedding. |
| `/memory supersede <id> <text>` | Same versioned replacement as update: stable ID, previous decision retained in history and excluded from search. |
| `/memory delete <id>` | Move to trash with confirmation. |
| `/memory trash [global\|project\|both]` | List trashed memories. |
| `/memory undelete <id>` | Restore from trash with confirmation. |
| `/memory purge <id>` | Permanently delete a trashed memory and its history with confirmation. |
| `/memory restore <id> <revision>` | Restore a previous revision with confirmation. |
| `/memory relink <old-path>` | Move a registered project's memories to the current checkout with confirmation. |
| `/memory reindex [global\|project\|both]` | Retry indexing up to 50 unindexed memories. |
| `/memory backup` | Create a PostgreSQL backup. |
| `/memory suggest [scope] [focus]` | Ask the agent to review the session and propose durable memories (scope: global, project or both); each save still needs your confirmation. |
| `/memory query <SELECT>` | Run a read-only SQL query, displaying a table of at most 100 rows and 30,000 characters. |

The three panels `/task`, `/context`, and `/memory` are independent. Opening one closes the previous panel; left/right never switch panels. Each extension works without the other two loaded. Escape closes the active panel.

Global memory holds reusable engineering experience/preferences across projects. Project memory holds decisions and facts specific to the current checkout; do not store those globally. Retrieval defaults to global plus the current project, using exact cosine distance and up to five indexed memories above `MEMORY_MIN_SIMILARITY` (default `0.6`). Debug also shows candidates below the threshold. There is no HNSW index and no automatic prompt injection. Debug reports explain this selection, not an LLM relevance judgment.

The `long_memory` agent tool supports stats, debug, history, supersede, list kind/offset filters, and a memory kind such as `preference` or `decision`. Each write requires interactive confirmation; it is unavailable without a UI. Retrieved memories are untrusted data. IDs are restricted to global or current-project scope for normal show/update/delete operations. `/memory query` is an explicit read-only view of all four tables, including other projects and revision history; it uses the separate `memory_reader` database role, a read-only transaction, and a statement timeout. Protect its credentials and do not grant that role write privileges or privileged role memberships.

Project identity is the canonical Git checkout root; outside Git it is the canonical working directory. Separate worktrees therefore have separate memory. Moving a checkout changes its identity. Project records are created when a project-scoped memory is saved and remain after memories are deleted.

Saving trims leading/trailing whitespace and reuses an identical memory in the same scope, even under concurrent saves. Updating to text already stored in that scope is rejected. This is exact-text deduplication, not semantic merging; existing duplicates are not deleted. Re-saving identical text retries indexing. Changed content is archived atomically in `memory_revisions`; identical-content reindexing does not add a revision. Delete moves the memory to trash, preserving its embedding and revision history. Trashed entries older than 30 days are purged when another memory is deleted; `/memory purge` removes one immediately.

Validation checks content/kind bounds, ID/scope access, embedding response shape, and explicit user approval. It does not establish factual truth or automatically infer engineering lessons; the user must review the proposed content before approving.

## Embeddings and privacy

Memory content and search queries are sent to Google's Gemini API. Free-tier terms may permit Google to use submitted content to improve its products. Do not save or search for passwords, API keys, or sensitive code unless you accept the applicable data handling. The extension does not automatically identify or redact secrets.

The model is `gemini-embedding-001`, with 768-dimensional vectors. Requests longer than 512 characters first call Google's token-count endpoint and reject inputs over 2,048 tokens; text is also limited to 8,000 characters. The endpoint currently requires the documented but deprecated top-level embedding configuration fields to honor the requested dimension; this must be rechecked if Google changes the API.

A memory is saved before its embedding is requested. If Google is unavailable, the memory remains readable and is marked `not indexed`, and the user is told why. Run `/memory reindex` to retry indexing after fixing the issue. Search requires Google and reports failures rather than silently substituting keyword search.

## Verification

`npm test` runs local tests; the PostgreSQL integration test is skipped unless `LONG_MEMORY_TEST_DATABASE_URL` and `LONG_MEMORY_TEST_READER_URL` point to the same dedicated disposable database, named `pi_memory_test` or `pi_memory_test_*`, initialized with this schema (including `memory_revisions`) and reader grants. Coverage includes scoped retrieval, exact/concurrent deduplication, history, statistics, debug details, filters/pages, SQL restrictions, and confirmation. UI tests cover panel replacement and removal of cross-panel arrow navigation. That test deletes all memories and projects in its target database and must never target a database with real memories. `LONG_MEMORY_TEST_DATABASE_URL` must use the restricted application role; optionally set `LONG_MEMORY_TEST_OWNER_URL` to test rejection of a privileged role. `npm run typecheck` checks the extension types.

## Agent behavior

The `long_memory` tool carries its own prompt guidelines (`src/prompts.ts`), so the agent knows from session start that it can search memory when a request depends on past decisions or preferences. It may also propose a global or project memory on its own when it learns something durable; the proposal is a normal `save` call, so the confirmation dialog is the suggestion and nothing is stored without your approval.
