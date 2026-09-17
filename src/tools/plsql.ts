import oracledb from "oracledb";
import { AppConfig, findConnection } from "../config.js";
import { withConfiguredConnection } from "../oracleClient.js";
import {
  assertDangerAllowed,
  assertReadwrite,
  checkDangerousSql,
  hasWriteOperations,
  isSelectOnly,
  requireSqlText,
} from "../safety.js";

function requirePlsqlAllowed(connName: string, allowed: boolean) {
  if (!allowed) {
    throw new Error(
      `Connection "${connName}" does not have "allowPlsql" enabled in the config. ` +
        `PL/SQL execution is blocked for this connection.`
    );
  }
}

function assertSafeProcedureName(procedureName: string): string {
  const name = procedureName.trim();
  if (!/^[A-Za-z][A-Za-z0-9_$#]*(\.[A-Za-z][A-Za-z0-9_$#]*){0,2}$/.test(name)) {
    throw new Error(
      `Invalid procedureName "${procedureName}". Use a simple identifier such as PKG_ORDERS.CANCEL_ORDER.`
    );
  }
  return name;
}

export async function executePlsql(
  config: AppConfig,
  connectionName: string,
  block: string,
  confirmDangerous: boolean = false
) {
  const conn = findConnection(config, connectionName);
  requirePlsqlAllowed(connectionName, conn.allowPlsql);
  const statement = requireSqlText(block, "block");

  if (hasWriteOperations(statement)) {
    assertReadwrite(connectionName, conn.mode, "PL/SQL that writes or changes objects");
  }
  assertDangerAllowed(checkDangerousSql(statement), conn.allowDangerous, confirmDangerous, connectionName);

  return withConfiguredConnection(config, conn, async (c) => {
    await c.execute(statement, [], { autoCommit: true });
    return { connection: connectionName, executed: true };
  });
}

export async function executeProcedure(
  config: AppConfig,
  connectionName: string,
  procedureName: string,
  bindParams: Record<string, unknown> = {}
) {
  const conn = findConnection(config, connectionName);
  requirePlsqlAllowed(connectionName, conn.allowPlsql);
  assertReadwrite(
    connectionName,
    conn.mode,
    "execute_procedure (side effects are unknown, so readonly connections cannot call stored procedures)"
  );

  const safeName = assertSafeProcedureName(procedureName);
  const bindNames = Object.keys(bindParams);
  const callArgs = bindNames.map((n) => `:${n}`).join(", ");
  const plsql = `BEGIN ${safeName}(${callArgs}); END;`;

  const binds: oracledb.BindParameters = {};
  for (const [k, v] of Object.entries(bindParams)) {
    (binds as Record<string, unknown>)[k] = v;
  }

  return withConfiguredConnection(config, conn, async (c) => {
    await c.execute(plsql, binds, { autoCommit: true });
    return { connection: connectionName, procedure: safeName, executed: true };
  });
}

export async function explainQuery(config: AppConfig, connectionName: string, sql: string) {
  const conn = findConnection(config, connectionName);
  const statement = requireSqlText(sql, "sql");

  if (!isSelectOnly(statement)) {
    throw new Error("explain_query only accepts a single SELECT / WITH statement.");
  }

  return withConfiguredConnection(config, conn, async (c) => {
    await c.execute(`EXPLAIN PLAN FOR ${statement}`);
    const plan = await c.execute(
      `SELECT plan_table_output AS "LINE" FROM TABLE(DBMS_XPLAN.DISPLAY())`
    );
    return {
      connection: connectionName,
      plan: (plan.rows as any[]).map((r) => r.LINE),
    };
  });
}
