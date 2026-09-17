import oracledb from "oracledb";
import { AppConfig, ConnectionConfig, buildConnectString, resolvePassword } from "./config.js";

// Return plain JS objects instead of oracledb's default array rows.
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
// Thin mode is the default in modern node-oracledb (no Instant Client needed).
// oracledb.initOracleClient() is intentionally NOT called here.

const pools = new Map<string, oracledb.Pool>();

async function getPool(conn: ConnectionConfig): Promise<oracledb.Pool> {
  const existing = pools.get(conn.name);
  if (existing) return existing;

  const pool = await oracledb.createPool({
    user: conn.username,
    password: resolvePassword(conn),
    connectString: buildConnectString(conn),
    poolMin: 0,
    poolMax: 4,
    poolIncrement: 1,
  });

  pools.set(conn.name, pool);
  return pool;
}

export function callTimeoutMs(config: AppConfig): number {
  const seconds = config.settings.queryTimeoutSeconds;
  return Math.max(1, Number.isFinite(seconds) ? seconds : 30) * 1000;
}

export async function withConnection<T>(
  conn: ConnectionConfig,
  fn: (c: oracledb.Connection) => Promise<T>,
  timeoutMs = 30_000
): Promise<T> {
  const pool = await getPool(conn);
  const connection = await pool.getConnection();
  connection.callTimeout = timeoutMs;
  try {
    return await fn(connection);
  } finally {
    await connection.close();
  }
}

export async function testConnection(conn: ConnectionConfig): Promise<Record<string, unknown>> {
  return withConnection(conn, async (c) => {
    const result = await c.execute<{ BANNER: string; SYSDATE: Date }>(
      `SELECT banner AS "BANNER" FROM v$version WHERE ROWNUM = 1`
    );
    const now = await c.execute<{ NOW: Date }>(`SELECT SYSDATE AS "NOW" FROM dual`);
    return {
      connected: true,
      serverBanner: (result.rows?.[0] as any)?.BANNER ?? "unknown",
      serverTime: (now.rows?.[0] as any)?.NOW ?? null,
    };
  });
}

export async function closeAllPools(): Promise<void> {
  for (const [name, pool] of pools) {
    try {
      await pool.close(5);
    } catch {
      // best-effort shutdown
    } finally {
      pools.delete(name);
    }
  }
}

export async function withConfiguredConnection<T>(
  config: AppConfig,
  conn: ConnectionConfig,
  fn: (c: oracledb.Connection) => Promise<T>
): Promise<T> {
  return withConnection(conn, fn, callTimeoutMs(config));
}
