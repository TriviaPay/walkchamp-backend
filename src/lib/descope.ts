import DescopeClient from "@descope/node-sdk";
import { config } from "./config.js";

let _client: ReturnType<typeof DescopeClient> | null = null;

export function getDescopeClient() {
  if (!_client) {
    _client = DescopeClient({
      projectId: config.auth.descopeProjectId!,
      managementKey: config.auth.descopeManagementKey ?? undefined,
    });
  }
  return _client;
}
