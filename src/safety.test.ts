import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkDangerousSql,
  hasWriteOperations,
  isSelectOnly,
  stripSqlComments,
} from "./safety.js";

describe("isSelectOnly", () => {
  it("accepts SELECT and WITH", () => {
    assert.equal(isSelectOnly("select * from dual"), true);
    assert.equal(isSelectOnly("WITH x AS (SELECT 1 a FROM dual) SELECT * FROM x"), true);
  });

  it("rejects empty or missing sql", () => {
    assert.equal(isSelectOnly(""), false);
    assert.equal(isSelectOnly("   "), false);
  });

  it("rejects DML disguised as WITH or stacked statements", () => {
    assert.equal(isSelectOnly("WITH x AS (SELECT 1 a FROM dual) INSERT INTO t SELECT * FROM x"), false);
    assert.equal(isSelectOnly("SELECT 1 FROM dual; DROP TABLE foo"), false);
    assert.equal(isSelectOnly("DELETE FROM t"), false);
  });

  it("ignores commented write tokens", () => {
    assert.equal(isSelectOnly("SELECT 1 FROM dual -- DELETE FROM t"), true);
    assert.equal(isSelectOnly("SELECT 1 /* INSERT */ FROM dual"), true);
  });
});

describe("checkDangerousSql", () => {
  it("flags DROP/TRUNCATE/ALTER SYSTEM anywhere in a block", () => {
    const drop = checkDangerousSql("BEGIN DROP TABLE foo; END;");
    assert.equal(drop.dangerous, true);
    assert.ok(drop.reasons.includes("DROP statement"));

    const truncate = checkDangerousSql("BEGIN TRUNCATE TABLE foo; END;");
    assert.equal(truncate.dangerous, true);
  });

  it("flags UPDATE/DELETE without WHERE inside PL/SQL", () => {
    const upd = checkDangerousSql("BEGIN UPDATE orders SET status = 'X'; END;");
    assert.equal(upd.dangerous, true);
    assert.ok(upd.reasons.some((r) => r.includes("UPDATE")));

    const ok = checkDangerousSql("BEGIN UPDATE orders SET status = 'X' WHERE id = 1; END;");
    assert.equal(ok.dangerous, false);
  });

  it("flags EXECUTE IMMEDIATE", () => {
    const check = checkDangerousSql("BEGIN EXECUTE IMMEDIATE 'TRUNCATE TABLE t'; END;");
    assert.equal(check.dangerous, true);
    assert.ok(check.reasons.includes("EXECUTE IMMEDIATE"));
  });
});

describe("hasWriteOperations", () => {
  it("detects writes inside anonymous blocks", () => {
    assert.equal(hasWriteOperations("BEGIN NULL; END;"), false);
    assert.equal(hasWriteOperations("BEGIN UPDATE t SET x = 1 WHERE id = 1; END;"), true);
    assert.equal(hasWriteOperations("CREATE OR REPLACE PROCEDURE p IS BEGIN NULL; END;"), true);
  });
});

describe("stripSqlComments", () => {
  it("removes line and block comments", () => {
    assert.equal(stripSqlComments("SELECT 1 -- hi\nFROM dual").includes("--"), false);
    assert.equal(stripSqlComments("SELECT /* x */ 1 FROM dual").includes("x"), false);
  });
});
