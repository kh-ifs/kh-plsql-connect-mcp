import oracledb from "oracledb";
import {
  AppConfig,
  HARD_MAX_LIST_ROWS,
  HARD_MAX_SOURCE_LINES,
  clampRows,
  findConnection,
} from "../config.js";
import { withConfiguredConnection } from "../oracleClient.js";

export type TableKind = "all" | "rtb" | "tab" | "lu";
export type TableObjectType = "TABLE" | "VIEW";
export type ProcedureKind = "all" | "api" | "sys" | "clf" | "svc" | "rpi";
export type SourcePart = "spec" | "body" | "all";

export interface ListTablesOptions {
  pattern?: string;
  objectType?: string;
  kind?: string;
  owner?: string;
  maxRows?: number;
}

export interface ListProceduresOptions {
  pattern?: string;
  kind?: string;
  owner?: string;
  maxRows?: number;
}

export interface SearchObjectsOptions {
  pattern: string;
  objectType?: string;
  owner?: string;
  maxRows?: number;
}

export interface GetSourceOptions {
  sourceType?: string;
  maxLines?: number;
  owner?: string;
}

function normalizeKind(value: string | undefined, allowed: string[]): string {
  const kind = (value ?? "all").trim().toLowerCase();
  if (!allowed.includes(kind)) {
    throw new Error(`Invalid kind "${value}". Allowed: ${allowed.join(", ")}.`);
  }
  return kind;
}

function tableKindClause(column: string, kind: string): string {
  switch (kind) {
    case "rtb":
      return `${column} LIKE '%\\_RTB' ESCAPE '\\'`;
    case "tab":
      return `${column} LIKE '%\\_TAB' ESCAPE '\\'`;
    case "lu":
      return `${column} NOT LIKE '%\\_RTB' ESCAPE '\\'
          AND ${column} NOT LIKE '%\\_TAB' ESCAPE '\\'
          AND ${column} NOT LIKE '%\\_VRT%' ESCAPE '\\'`;
    default:
      return "1=1";
  }
}

function packageKindClause(column: string, kind: string): string {
  switch (kind) {
    case "api":
      return `${column} LIKE '%\\_API' ESCAPE '\\'`;
    case "sys":
      return `${column} LIKE '%\\_SYS' ESCAPE '\\'`;
    case "clf":
      return `${column} LIKE '%\\_CLF' ESCAPE '\\'`;
    case "svc":
      return `${column} LIKE '%\\_SVC' ESCAPE '\\'`;
    case "rpi":
      return `${column} LIKE '%\\_RPI' ESCAPE '\\'`;
    default:
      return "1=1";
  }
}

function relatedNames(name: string) {
  const upper = name.toUpperCase();
  if (upper.endsWith("_RTB")) {
    const base = upper.slice(0, -4);
    return { base, rtb: upper, tab: `${base}_TAB`, luView: base };
  }
  if (upper.endsWith("_TAB")) {
    const base = upper.slice(0, -4);
    return { base, rtb: `${base}_RTB`, tab: upper, luView: base };
  }
  return { base: upper, rtb: `${upper}_RTB`, tab: `${upper}_TAB`, luView: upper };
}

function likePattern(pattern?: string | null): string {
  const raw = pattern?.trim();
  return raw ? raw.toUpperCase() : "%";
}

function joinSource(rows: any[], type: string, maxLines: number) {
  const ofType = rows.filter((r) => r.TYPE === type).sort((a, b) => a.LINE - b.LINE);
  const truncated = ofType.length > maxLines;
  const source = ofType
    .slice(0, maxLines)
    .map((r) => r.TEXT)
    .join("");
  return { source: source || null, lines: ofType.length, truncated };
}

export async function listTables(config: AppConfig, connectionName: string, options: ListTablesOptions = {}) {
  const conn = findConnection(config, connectionName);
  const kind = normalizeKind(options.kind, ["all", "rtb", "tab", "lu"]);
  const objectType = options.objectType ? options.objectType.trim().toUpperCase() : undefined;
  if (objectType && objectType !== "TABLE" && objectType !== "VIEW") {
    throw new Error(`Invalid objectType "${options.objectType}". Use TABLE or VIEW.`);
  }
  const rowLimit = clampRows(options.maxRows, config.settings.defaultMaxListRows, HARD_MAX_LIST_ROWS);
  const owner = options.owner?.trim().toUpperCase();
  const pattern = likePattern(options.pattern);
  const typePat = objectType ?? "%";
  const fromSql = owner
    ? `SELECT owner AS owner_name, table_name AS object_name, 'TABLE' AS object_type FROM all_tables
       UNION ALL
       SELECT owner, view_name, 'VIEW' FROM all_views`
    : `SELECT USER AS owner_name, table_name AS object_name, 'TABLE' AS object_type FROM user_tables
       UNION ALL
       SELECT USER, view_name, 'VIEW' FROM user_views`;
  const ownerClause = owner ? "AND owner_name = :schemaOwner" : "";
  const binds: oracledb.BindParameters = {
    pattern,
    objectType: typePat,
    fetchLimit: rowLimit + 1,
    ...(owner ? { schemaOwner: owner } : {}),
  };

  return withConfiguredConnection(config, conn, async (c) => {
    const result = await c.execute(
      `SELECT "OWNER", "TABLE_NAME", "TYPE" FROM (
         SELECT q.*, ROWNUM AS rn FROM (
           SELECT owner_name AS "OWNER", object_name AS "TABLE_NAME", object_type AS "TYPE"
           FROM (${fromSql})
           WHERE object_name LIKE :pattern
             ${ownerClause}
             AND object_type LIKE :objectType
             AND ${tableKindClause("object_name", kind)}
           ORDER BY object_name
         ) q
       ) WHERE rn <= :fetchLimit`,
      binds
    );
    const rows = (result.rows as any[]) ?? [];
    const truncated = rows.length > rowLimit;
    const warning =
      !options.pattern && kind === "all"
        ? `No pattern/kind supplied; results capped at ${rowLimit}. On IFS schemas pass pattern (e.g. 'CUSTOMER_ORDER%') or kind (rtb/tab/lu).`
        : undefined;
    return {
      connection: connectionName,
      owner: owner ?? null,
      kind,
      objectType: objectType ?? "ALL",
      rowCount: Math.min(rows.length, rowLimit),
      truncated,
      maxRows: rowLimit,
      warning,
      objects: rows.slice(0, rowLimit),
    };
  });
}

export async function describeTable(
  config: AppConfig,
  connectionName: string,
  tableName: string,
  owner?: string
) {
  const conn = findConnection(config, connectionName);
  const name = tableName.trim();
  if (!name) throw new Error(`Missing required argument "tableName".`);
  const ownerName = owner?.trim().toUpperCase();
  const catalog = ownerName ? "all" : "user";
  const ownerFilter = ownerName ? "AND owner = :owner" : "";

  return withConfiguredConnection(config, conn, async (c) => {
    const ownerBinds = ownerName ? { owner: ownerName } : {};
    const columns = await c.execute(
      `SELECT column_name AS "COLUMN_NAME", data_type AS "DATA_TYPE",
              data_length AS "DATA_LENGTH", data_precision AS "DATA_PRECISION",
              data_scale AS "DATA_SCALE", char_length AS "CHAR_LENGTH",
              nullable AS "NULLABLE", data_default AS "DEFAULT_VALUE"
       FROM ${catalog}_tab_columns
       WHERE table_name = UPPER(:tableName) ${ownerFilter}
       ORDER BY column_id`,
      { tableName: name, ...ownerBinds }
    );

    if (!columns.rows || columns.rows.length === 0) {
      throw new Error(
        `Table/view "${tableName}" not found (or not accessible) via connection "${connectionName}".`
      );
    }

    const related = relatedNames(name);
    const objects = await c.execute(
      `SELECT object_name AS "OBJECT_NAME", object_type AS "OBJECT_TYPE", status AS "STATUS"
       FROM ${catalog}_objects
       WHERE object_name IN (UPPER(:tableName), :rtb, :tab, :luView)
         AND object_type IN ('TABLE', 'VIEW')
         ${ownerFilter}`,
      { tableName: name, rtb: related.rtb, tab: related.tab, luView: related.luView, ...ownerBinds }
    );
    const found = new Set(((objects.rows as any[]) ?? []).map((r) => r.OBJECT_NAME as string));
    const described = ((objects.rows as any[]) ?? []).find((r) => r.OBJECT_NAME === name.toUpperCase());
    const objectType = described?.OBJECT_TYPE ?? "UNKNOWN";

    const constraintTable =
      objectType === "VIEW" && found.has(related.rtb) ? related.rtb : name;

    const ownerJoin = ownerName ? "AND c.owner = cc.owner" : "";
    const constraints = await c.execute(
      `SELECT cc.constraint_name AS "CONSTRAINT_NAME", c.constraint_type AS "TYPE",
              cc.column_name AS "COLUMN_NAME", cc.table_name AS "TABLE_NAME"
       FROM ${catalog}_cons_columns cc
       JOIN ${catalog}_constraints c
         ON c.constraint_name = cc.constraint_name
        ${ownerJoin}
       WHERE cc.table_name = UPPER(:constraintTable) ${ownerFilter}
       ORDER BY c.constraint_type, cc.position`,
      { constraintTable, ...ownerBinds }
    );

    const constraintsFromRtb = constraintTable.toUpperCase() !== name.toUpperCase();

    return {
      connection: connectionName,
      owner: ownerName ?? null,
      table: name.toUpperCase(),
      objectType,
      related: {
        rtb: found.has(related.rtb) ? related.rtb : null,
        tab: found.has(related.tab) ? related.tab : null,
        luView: found.has(related.luView) ? related.luView : null,
      },
      note: constraintsFromRtb
        ? `This is an editioning/LU view. Constraints were read from ${constraintTable} (_RTB is the real table; _TAB is the editioning view).`
        : objectType === "VIEW"
          ? "This is a view. Keys/constraints usually live on the matching _RTB table."
          : undefined,
      columns: columns.rows,
      constraints: constraints.rows,
      constraintsFrom: constraintsFromRtb ? constraintTable : name.toUpperCase(),
    };
  });
}

export async function listProcedures(
  config: AppConfig,
  connectionName: string,
  options: ListProceduresOptions = {}
) {
  const conn = findConnection(config, connectionName);
  const kind = normalizeKind(options.kind, ["all", "api", "sys", "clf", "svc", "rpi"]);
  const rowLimit = clampRows(options.maxRows, config.settings.defaultMaxListRows, HARD_MAX_LIST_ROWS);
  const owner = options.owner?.trim().toUpperCase();
  const pattern = likePattern(options.pattern);
  const catalog = owner ? "all" : "user";
  const ownerCol = owner ? "owner" : "USER";
  const ownerClause = owner ? "AND owner = :schemaOwner" : "";
  const binds: oracledb.BindParameters = {
    pattern,
    fetchLimit: rowLimit + 1,
    ...(owner ? { schemaOwner: owner } : {}),
  };

  return withConfiguredConnection(config, conn, async (c) => {
    const result = await c.execute(
      `SELECT "OWNER", "OBJECT_NAME", "OBJECT_TYPE", "STATUS" FROM (
         SELECT q.*, ROWNUM AS rn FROM (
           SELECT ${ownerCol} AS "OWNER", object_name AS "OBJECT_NAME",
                  object_type AS "OBJECT_TYPE", status AS "STATUS"
           FROM ${catalog}_objects
           WHERE object_type IN ('PROCEDURE', 'FUNCTION', 'PACKAGE')
             ${ownerClause}
             AND object_name LIKE :pattern
             AND ${packageKindClause("object_name", kind)}
           ORDER BY object_type, object_name
         ) q
       ) WHERE rn <= :fetchLimit`,
      binds
    );
    const rows = (result.rows as any[]) ?? [];
    const truncated = rows.length > rowLimit;
    const warning =
      !options.pattern && kind === "all"
        ? `No pattern/kind supplied; results capped at ${rowLimit}. On IFS schemas pass pattern (e.g. 'CUSTOMER_ORDER%') or kind (api/sys/clf).`
        : undefined;
    return {
      connection: connectionName,
      owner: owner ?? null,
      kind,
      rowCount: Math.min(rows.length, rowLimit),
      truncated,
      maxRows: rowLimit,
      warning,
      objects: rows.slice(0, rowLimit),
    };
  });
}

export async function searchObjects(
  config: AppConfig,
  connectionName: string,
  options: SearchObjectsOptions
) {
  const conn = findConnection(config, connectionName);
  const pattern = options.pattern?.trim();
  if (!pattern) throw new Error(`search_objects requires a LIKE pattern (e.g. 'CUSTOMER_ORDER%').`);
  const objectType = options.objectType?.trim().toUpperCase();
  const owner = options.owner?.trim().toUpperCase();
  const rowLimit = clampRows(options.maxRows, config.settings.defaultMaxListRows, HARD_MAX_LIST_ROWS);
  const catalog = owner ? "all" : "user";
  const ownerCol = owner ? "owner" : "USER";
  const ownerClause = owner ? "AND owner = :schemaOwner" : "";
  const typeClause = objectType ? "AND object_type = :objectType" : "";
  const binds: oracledb.BindParameters = {
    pattern: pattern.toUpperCase(),
    fetchLimit: rowLimit + 1,
    ...(objectType ? { objectType } : {}),
    ...(owner ? { schemaOwner: owner } : {}),
  };

  return withConfiguredConnection(config, conn, async (c) => {
    const result = await c.execute(
      `SELECT "OWNER", "OBJECT_NAME", "OBJECT_TYPE", "STATUS", "LAST_DDL_TIME" FROM (
         SELECT q.*, ROWNUM AS rn FROM (
           SELECT ${ownerCol} AS "OWNER", object_name AS "OBJECT_NAME",
                  object_type AS "OBJECT_TYPE", status AS "STATUS",
                  last_ddl_time AS "LAST_DDL_TIME"
           FROM ${catalog}_objects
           WHERE object_name LIKE :pattern
             ${ownerClause}
             ${typeClause}
           ORDER BY object_type, object_name
         ) q
       ) WHERE rn <= :fetchLimit`,
      binds
    );
    const rows = (result.rows as any[]) ?? [];
    return {
      connection: connectionName,
      owner: owner ?? null,
      pattern,
      objectType,
      rowCount: Math.min(rows.length, rowLimit),
      truncated: rows.length > rowLimit,
      maxRows: rowLimit,
      objects: rows.slice(0, rowLimit),
    };
  });
}

export async function getProcedureSource(
  config: AppConfig,
  connectionName: string,
  objectName: string,
  options: GetSourceOptions = {}
) {
  const conn = findConnection(config, connectionName);
  const name = objectName.trim();
  if (!name) throw new Error(`Missing required argument "objectName".`);
  const sourceType = normalizeKind(options.sourceType ?? "all", ["spec", "body", "all"]) as SourcePart;
  const maxLines = clampRows(
    options.maxLines,
    config.settings.defaultMaxSourceLines,
    HARD_MAX_SOURCE_LINES
  );
  const owner = options.owner?.trim().toUpperCase();
  const catalog = owner ? "all" : "user";
  const ownerFilter = owner ? "AND owner = :owner" : "";

  return withConfiguredConnection(config, conn, async (c) => {
    const result = await c.execute(
      `SELECT type AS "TYPE", line AS "LINE", text AS "TEXT"
       FROM ${catalog}_source
       WHERE name = UPPER(:objectName) ${ownerFilter}
       ORDER BY type, line`,
      owner ? { objectName: name, owner } : { objectName: name }
    );

    if (!result.rows || result.rows.length === 0) {
      throw new Error(`No source found for "${objectName}" via connection "${connectionName}".`);
    }

    const rows = result.rows as any[];
    const types = [...new Set(rows.map((r) => r.TYPE as string))];
    const specType = types.find((t) => t === "PACKAGE" || t === "PROCEDURE" || t === "FUNCTION") ?? types[0];
    const bodyType = types.find((t) => t === "PACKAGE BODY" || t === "TYPE BODY");
    const spec = joinSource(rows, specType, maxLines);
    const body = bodyType ? joinSource(rows, bodyType, maxLines) : { source: null, lines: 0, truncated: false };

    const includeSpec = sourceType === "all" || sourceType === "spec";
    const includeBody = sourceType === "all" || sourceType === "body";

    return {
      connection: connectionName,
      owner: owner ?? null,
      object: name.toUpperCase(),
      types,
      spec: includeSpec ? spec.source : null,
      specLines: spec.lines,
      specTruncated: includeSpec ? spec.truncated : false,
      body: includeBody ? body.source : null,
      bodyLines: body.lines,
      bodyTruncated: includeBody ? body.truncated : false,
      maxLines,
      hint:
        spec.truncated || body.truncated
          ? `Source truncated at ${maxLines} lines per part. Re-run with sourceType=spec|body or a higher maxLines.`
          : body.lines > 800 && sourceType === "all"
            ? "Large package. Prefer sourceType=spec first, then sourceType=body if you need implementation."
            : undefined,
    };
  });
}

export async function describeProcedure(
  config: AppConfig,
  connectionName: string,
  objectName: string,
  owner?: string
) {
  const conn = findConnection(config, connectionName);
  const raw = objectName.trim();
  if (!raw) throw new Error(`Missing required argument "objectName".`);
  const ownerName = owner?.trim().toUpperCase();
  const catalog = ownerName ? "all" : "user";
  const ownerFilter = ownerName ? "AND owner = :owner" : "";

  const parts = raw.split(".").map((p) => p.trim()).filter(Boolean);
  const packageName = parts.length >= 2 ? parts[0].toUpperCase() : null;
  const methodName = (parts.length >= 2 ? parts[1] : parts[0]).toUpperCase();
  const binds: oracledb.BindParameters = {
    ...(packageName ? { packageName, methodName } : { objectName: methodName }),
    ...(ownerName ? { owner: ownerName } : {}),
  };

  return withConfiguredConnection(config, conn, async (c) => {
    const result = await c.execute(
      `SELECT package_name AS "PACKAGE_NAME", object_name AS "OBJECT_NAME",
              overload AS "OVERLOAD", argument_name AS "ARGUMENT_NAME",
              position AS "POSITION", sequence AS "SEQUENCE",
              data_type AS "DATA_TYPE", in_out AS "IN_OUT",
              data_level AS "DATA_LEVEL", defaulted AS "DEFAULTED"
       FROM ${catalog}_arguments
       WHERE ${
         packageName
           ? "package_name = :packageName AND object_name = :methodName"
           : ":objectName IN (package_name, object_name)"
       }
         ${ownerFilter}
       ORDER BY package_name, object_name, overload, sequence`,
      binds
    );

    if (!result.rows || result.rows.length === 0) {
      throw new Error(
        `No arguments found for "${objectName}" via connection "${connectionName}". ` +
          `For a package method use PACKAGE_NAME.METHOD_NAME.`
      );
    }

    return {
      connection: connectionName,
      owner: ownerName ?? null,
      object: raw.toUpperCase(),
      argumentCount: result.rows.length,
      arguments: result.rows,
    };
  });
}
