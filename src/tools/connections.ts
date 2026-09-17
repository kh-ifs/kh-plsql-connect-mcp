import { AppConfig, findConnection } from "../config.js";
import { testConnection } from "../oracleClient.js";

export function listConnections(config: AppConfig) {
  return config.connections.map((c) => ({
    name: c.name,
    mode: c.mode,
    allowPlsql: c.allowPlsql,
    allowDangerous: c.allowDangerous,
    target: c.connectionString ?? `${c.host}:${c.port}/${c.serviceName ?? c.sid}`,
  }));
}

export async function testConnectionTool(config: AppConfig, name: string) {
  const conn = findConnection(config, name);
  try {
    const info = await testConnection(conn);
    return { connection: name, ...info };
  } catch (err) {
    return { connection: name, connected: false, error: (err as Error).message };
  }
}
