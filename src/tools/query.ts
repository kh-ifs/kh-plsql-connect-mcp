import { AppConfig, HARD_MAX_QUERY_ROWS, clampRows, findConnection } from "../config.js";
import { withConfiguredConnection } from "../oracleClient.js";
import { assertDangerAllowed, assertReadwrite, checkDangerousSql, isSelectOnly, requireSqlText } from "../safety.js";

export async function executeQuery(
  config: AppConfig,
  connectionName: string,
  sql: string,
  maxRows?: number
) {
  const conn = findConnection(config, connectionName);
  const statement = requireSqlText(sql, "sql");

  if (!isSelectOnly(statement)) {
    throw new Error(
      `execute_query only accepts a single SELECT / WITH statement. Use execute_dml for writes ` +
        `(requires a "readwrite" connection) or execute_plsql for PL/SQL blocks.`
    );
  }

  const rowLimit = clampRows(maxRows, config.settings.defaultMaxRows, HARD_MAX_QUERY_ROWS);

  return withConfiguredConnection(config, conn, async (c) => {
    const result = await c.execute(statement, [], { maxRows: rowLimit });
    return {
      connection: connectionName,
      rowCount: result.rows?.length ?? 0,
      truncated: (result.rows?.length ?? 0) >= rowLimit,
      maxRows: rowLimit,
      rows: result.rows,
    };
  });
}

export async function executeDml(
  config: AppConfig,
  connectionName: string,
  sql: string,
  confirmDangerous: boolean = false
) {
  const conn = findConnection(config, connectionName);
  const statement = requireSqlText(sql, "sql");
  assertReadwrite(connectionName, conn.mode, "INSERT/UPDATE/DELETE/MERGE");
  assertDangerAllowed(checkDangerousSql(statement), conn.allowDangerous, confirmDangerous, connectionName);

  // Each tool call uses a fresh pooled connection that is closed when the call
  // returns, so statements are auto-committed individually.
  return withConfiguredConnection(config, conn, async (c) => {
    const result = await c.execute(statement, [], { autoCommit: true });
    return {
      connection: connectionName,
      rowsAffected: result.rowsAffected ?? 0,
      committed: true,
    };
  });
}
