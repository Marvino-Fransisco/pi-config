FROM pgvector/pgvector:pg18
COPY schema.sql /docker-entrypoint-initdb.d/10-schema.sql
COPY init.sh /docker-entrypoint-initdb.d/20-roles.sh
COPY migrate.sql /docker-entrypoint-initdb.d/migrate.sql.in
