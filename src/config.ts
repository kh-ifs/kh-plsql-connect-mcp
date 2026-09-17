import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export type ConnectionMode = "readonly" | "readwrite";

export interface ConnectionConfig {
  name: string;
  host?: string;
  port?: number;
  serviceName?: string;
  sid?: string;
  connectionString?: string;
  username: string;
  password?: string;
  passwordEnv?: string;
  mode: ConnectionMode;
  allowPlsql: boolean;
  allowDangerous: boolean;
}

export interface AppSettings {
  defaultMaxRows: number;
  defaultMaxListRows: number;
  defaultMaxSourceLines: number;
  queryTimeoutSeconds: number;
}

export const HARD_MAX_QUERY_ROWS = 2000;
export const HARD_MAX_LIST_ROWS = 500;
export const HARD_MAX_SOURCE_LINES = 8000;

export interface AppConfig {
  settings: AppSettings;
  connections: ConnectionConfig[];
}

const DEFAULT_SETTINGS: AppSettings = {
  defaultMaxRows: 200,
  defaultMaxListRows: 100,
  defaultMaxSourceLines: 3000,
  queryTimeoutSeconds: 30,
};

export function clampRows(requested: number | undefined, fallback: number, hardMax: number): number {
  const n = requested ?? fallback;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), hardMax);
}

function candidatePaths(): string[] {
  const fromEnv = process.env.ORACLE_MCP_CONFIG;
  const home = os.homedir();
  return [
    ...(fromEnv ? [fromEnv] : []),
    path.resolve(process.cwd(), "config", "connections.json"),
    path.resolve(process.cwd(), "connections.json"),
    path.join(home, ".oracle-mcp", "connections.json"),
  ];
}

export function loadConfig(): AppConfig {
  const candidates = candidatePaths();
  const foundPath = candidates.find((p) => p && fs.existsSync(p));

  if (!foundPath) {
    throw new Error(
      "No connections config found. Set ORACLE_MCP_CONFIG to a JSON file, or place one at " +
        "./config/connections.json, ./connections.json, or ~/.oracle-mcp/connections.json.\n" +
        "See config/connections.example.json for the expected format."
    );
  }

  const raw = fs.readFileSync(foundPath, "utf-8");
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse config at ${foundPath}: ${(err as Error).message}`);
  }

  const settings: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...(parsed.settings ?? {}),
  };

  const connectionsRaw = Array.isArray(parsed.connections) ? parsed.connections : [];
  if (connectionsRaw.length === 0) {
    throw new Error(`Config at ${foundPath} has no connections defined.`);
  }

  const seenNames = new Set<string>();
  const connections: ConnectionConfig[] = connectionsRaw.map((c: any, idx: number) => {
    if (!c.name) throw new Error(`Connection at index ${idx} is missing "name".`);
    if (seenNames.has(c.name)) throw new Error(`Duplicate connection name: "${c.name}".`);
    seenNames.add(c.name);

    if (!c.username) throw new Error(`Connection "${c.name}" is missing "username".`);
    if (!c.password && !c.passwordEnv) {
      throw new Error(
        `Connection "${c.name}" needs either "password" (plain text, local testing only) or "passwordEnv".`
      );
    }
    if (c.password) {
      console.error(
        `WARNING: connection "${c.name}" uses a plain-text password in the config file. ` +
          `Fine for local testing; switch to "passwordEnv" before sharing this config or committing it anywhere.`
      );
    }
    if (!c.connectionString && !c.host) {
      throw new Error(`Connection "${c.name}" needs either "connectionString" or "host".`);
    }
    if (c.mode !== "readonly" && c.mode !== "readwrite") {
      throw new Error(`Connection "${c.name}" has invalid "mode" (must be "readonly" or "readwrite").`);
    }

    return {
      name: c.name,
      host: c.host,
      port: c.port ?? 1521,
      serviceName: c.serviceName,
      sid: c.sid,
      connectionString: c.connectionString,
      username: c.username,
      password: c.password,
      passwordEnv: c.passwordEnv,
      mode: c.mode,
      allowPlsql: Boolean(c.allowPlsql),
      allowDangerous: Boolean(c.allowDangerous),
    };
  });

  return { settings, connections };
}

export function resolvePassword(conn: ConnectionConfig): string {
  if (conn.password) return conn.password;
  if (!conn.passwordEnv) {
    throw new Error(`Connection "${conn.name}" has no password or passwordEnv configured.`);
  }
  const pwd = process.env[conn.passwordEnv];
  if (!pwd) {
    throw new Error(
      `Environment variable "${conn.passwordEnv}" is not set (required for connection "${conn.name}"). ` +
        `Set it before starting the MCP server.`
    );
  }
  return pwd;
}

export function buildConnectString(conn: ConnectionConfig): string {
  if (conn.connectionString) return conn.connectionString;
  if (conn.sid) return `${conn.host}:${conn.port}/${conn.sid}`;
  return `${conn.host}:${conn.port}/${conn.serviceName}`;
}

export function findConnection(config: AppConfig, name: string): ConnectionConfig {
  const conn = config.connections.find((c) => c.name === name);
  if (!conn) {
    const available = config.connections.map((c) => c.name).join(", ");
    throw new Error(`Unknown connection "${name}". Available connections: ${available}`);
  }
  return conn;
}
