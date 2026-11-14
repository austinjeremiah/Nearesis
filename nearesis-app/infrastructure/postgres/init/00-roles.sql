-- Application role is NOT superuser and NOT BYPASSRLS, so row-level security applies (K01/K04/A17).
CREATE ROLE nearesis_app LOGIN PASSWORD 'nearesis_app' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE nearesis TO nearesis_app;
