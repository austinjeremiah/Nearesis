// Cube Core server config. The security context is built by the semantic gateway from the server session only.
module.exports = {
  contextToAppId: ({ securityContext }) =>
    `NEARESIS_${securityContext && securityContext.workspaceId ? "scoped" : "anon"}`,
  queryRewrite: (query, { securityContext }) => {
    if (!securityContext || !securityContext.tenantId || !securityContext.workspaceId) {
      throw new Error("security context (tenantId, workspaceId) is required");
    }
    return query;
  },
};
