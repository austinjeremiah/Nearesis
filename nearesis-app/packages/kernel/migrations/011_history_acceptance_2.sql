-- Public assets are published by operators and migrations, never by tenants: the application role may only read them.
REVOKE INSERT ON public_assets FROM nearesis_app;
