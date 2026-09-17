export interface DangerCheck {
  dangerous: boolean;
  reasons: string[];
}

/** Strip `--` and `/* *\/` comments while leaving quoted literals intact. */
export function stripSqlComments(sql: string): string {
  if (typeof sql !== "string") return "";
  let out = "";
  let i = 0;
  let inSingle = false;
  let inDouble = false;

  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];

    if (!inSingle && !inDouble && c === "-" && n === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (!inSingle && !inDouble && c === "/" && n === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    if (!inDouble && c === "'") {
      inSingle = !inSingle;
      out += c;
      i++;
      continue;
    }
    if (!inSingle && c === '"') {
      inDouble = !inDouble;
      out += c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function normalizeSql(sql: string): string {
  return stripSqlComments(sql).replace(/\s+/g, " ").trim().toUpperCase();
}

function requireSql(sql: unknown, label: string): string {
  if (typeof sql !== "string" || !sql.trim()) {
    throw new Error(`Missing required ${label}.`);
  }
  return sql;
}

/**
 * Heuristic checks for statements that are risky enough to require
 * a connection to explicitly opt in via "allowDangerous".
 * Scans every statement in a block, not only the first token.
 */
export function checkDangerousSql(sql: string): DangerCheck {
  const reasons: string[] = [];
  if (typeof sql !== "string" || !sql.trim()) {
    return { dangerous: false, reasons };
  }

  const normalized = normalizeSql(sql);
  const parts = normalized.split(";").map((s) => s.trim()).filter(Boolean);

  for (const stmt of parts) {
    if (/\bDROP\b/.test(stmt)) reasons.push("DROP statement");
    if (/\bTRUNCATE\b/.test(stmt)) reasons.push("TRUNCATE statement");
    if (/\bALTER\s+SYSTEM\b/.test(stmt)) reasons.push("ALTER SYSTEM command");
    if (/\bEXECUTE\s+IMMEDIATE\b/.test(stmt)) reasons.push("EXECUTE IMMEDIATE");
    if (/\bGRANT\b/.test(stmt) || /\bREVOKE\b/.test(stmt)) reasons.push("GRANT/REVOKE");

    const pieces = stmt.split(/(?=\bUPDATE\b|\bDELETE\b)/);
    for (const piece of pieces) {
      const p = piece.trim();
      if (/^UPDATE\b/.test(p) && !/\bWHERE\b/.test(p)) {
        reasons.push("UPDATE without a WHERE clause (affects all rows)");
      }
      if (/^DELETE\b/.test(p) && !/\bWHERE\b/.test(p)) {
        reasons.push("DELETE without a WHERE clause (affects all rows)");
      }
    }
  }

  return { dangerous: reasons.length > 0, reasons: [...new Set(reasons)] };
}

export function isSelectOnly(sql: string): boolean {
  if (typeof sql !== "string" || !sql.trim()) return false;
  const body = normalizeSql(sql).replace(/;\s*$/, "");
  if (!body || body.includes(";")) return false;

  const writeInside =
    /\b(INSERT|UPDATE|DELETE|MERGE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE)\b/;

  if (body.startsWith("SELECT")) return !writeInside.test(body.slice("SELECT".length));
  if (body.startsWith("WITH")) return !writeInside.test(body);
  return false;
}

const WRITE_RE =
  /\b(INSERT|UPDATE|DELETE|MERGE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|EXECUTE\s+IMMEDIATE)\b/;

export function hasWriteOperations(sql: string): boolean {
  if (typeof sql !== "string" || !sql.trim()) return false;
  return WRITE_RE.test(normalizeSql(sql));
}

export function assertDangerAllowed(
  check: DangerCheck,
  allowDangerous: boolean,
  confirmDangerous: boolean,
  connectionName: string
): void {
  if (!check.dangerous) return;
  const why = check.reasons.join(", ");
  if (!allowDangerous) {
    throw new Error(
      `Blocked: flagged as dangerous (${why}) and connection "${connectionName}" does not have "allowDangerous" enabled.`
    );
  }
  if (!confirmDangerous) {
    throw new Error(
      `This statement was flagged as dangerous (${why}). Re-run with confirmDangerous=true to proceed.`
    );
  }
}

export function assertReadwrite(connectionName: string, mode: string, action: string): void {
  if (mode !== "readwrite") {
    throw new Error(
      `Connection "${connectionName}" is read-only. ${action} is not permitted. ` +
        `Change its "mode" to "readwrite" in the config if this is intentional.`
    );
  }
}

export function requireSqlText(sql: unknown, label = "sql"): string {
  return requireSql(sql, label);
}
