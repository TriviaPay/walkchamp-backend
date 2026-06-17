import DescopeClient from "@descope/node-sdk";

let _client: ReturnType<typeof DescopeClient> | null = null;

export function getDescopeClient() {
  if (!_client) {
    const projectId = process.env.DESCOPE_PROJECT_ID;
    if (!projectId) throw new Error("DESCOPE_PROJECT_ID is not set");
    _client = DescopeClient({
      projectId,
      managementKey: process.env.DESCOPE_MANAGEMENT_KEY,
    });
  }
  return _client;
}
