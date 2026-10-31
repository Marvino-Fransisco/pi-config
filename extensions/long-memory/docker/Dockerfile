FROM pgvector/pgvector:pg18
COPY schema.sql /docker-entrypoint-initdb.d/10-schema.sql
COPY init.sh /docker-entrypoint-initdb.d/20-reader.sh
