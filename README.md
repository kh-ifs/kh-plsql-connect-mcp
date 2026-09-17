# kh-plsql-connect

![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18-green)
![Status](https://img.shields.io/badge/status-early--version-orange)
![Author](https://img.shields.io/badge/author-Kanchana%20Henarath-informational)

Kanchana Henarath

A local MCP server that gives Cursor controlled access to one or more Oracle/PLSQL
databases — query, browse schema, and (optionally) run PL/SQL — with per-connection
safety controls you define yourself.

Created by **Kanchana Henarath**.

Runs entirely on your machine. No hosting, no third-party service, no data leaves
your network beyond your normal Oracle connection (which still needs your usual VPN).

Built for large IFS Cloud schemas as well as smaller Oracle databases: list/search
tools are capped, editioning `_RTB` / `_TAB` names are resolved, and package source
is split into spec and body.

## Contents

- [Requirements](#requirements)
- [Recommended setup for shared use](#recommended-setup-for-shared-use)
- [1. Install dependencies](#1-install-dependencies)
- [2. Create your connections config](#2-create-your-connections-config)
- [3. Set the database password](#3-set-the-database-password)
- [4. Point Cursor at this server](#4-point-cursor-at-this-server)
- [5. Try it](#5-try-it)
- [Tools](#tools)
- [Safety model](#safety-model)
- [Roadmap](#roadmap)

## Requirements

- Node.js 18 or newer
- Access to an Oracle / IFS Cloud database (host/port/service reachable — typically
  requires your usual VPN)
- Cursor, or any other MCP-compatible client

## Recommended setup for shared use

Each person clones this repo and keeps their own `config/connections.json` (gitignored).
**Start every connection as `mode: "readonly"`** unless you intentionally need DML or
PL/SQL writes. That is the safe default for IFS Cloud Use Places.

```json
{
  "name": "ifs_dev",
  "mode": "readonly",
  "allowPlsql": false,
  "allowDangerous": false
}
```

Only flip a named connection to `readwrite` / `allowPlsql: true` when you mean to change that database.

## 1. Install dependencies

```powershell
cd kh-plsql-connect
npm install
npm run build
```

This compiles TypeScript to `dist/`. Re-run `npm run build` any time you change the code,
then restart the MCP server in Cursor so it picks up the new `dist/`.

## 2. Create your connections config

Copy the example and edit it:

```powershell
copy config\connections.example.json config\connections.json
```

Edit `config\connections.json` — one entry per database/project. Key fields:

| Field            | Meaning                                                                 |
|------------------|--------------------------------------------------------------------------|
| `name`           | What you'll refer to this connection as in Cursor chat                  |
| `host`/`port`/`serviceName` (or `connectionString`) | How to reach the DB              |
| `username`       | DB username                                                               |
| `passwordEnv`    | Preferred: name of an environment variable holding the password           |
| `password`       | Optional plain-text password in this file (local use only). Used if set; otherwise `passwordEnv` is read. |
| `mode`           | `"readonly"` (recommended) blocks DML, write PL/SQL, and procedure calls. `"readwrite"` allows them. |
| `allowPlsql`     | Whether PL/SQL block/procedure execution is allowed on this connection   |
| `allowDangerous` | Whether DROP/TRUNCATE/ALTER SYSTEM/unqualified UPDATE-DELETE can run at all (still requires `confirmDangerous:true` per call) |

Optional `settings`:

| Field | Default | Meaning |
|-------|---------|---------|
| `defaultMaxRows` | 200 | Row cap for `execute_query` |
| `defaultMaxListRows` | 100 | Row cap for list/search tools (hard max 500) |
| `defaultMaxSourceLines` | 3000 | Per-part cap for `get_procedure_source` |
| `queryTimeoutSeconds` | 30 | Applied as `callTimeout` on every Oracle execute |

Each connection needs **one** of `passwordEnv` (preferred) or `password` (plain text in the file).
If both are set, `password` wins.

**Never commit `config/connections.json`.** It is gitignored on purpose. A plain-text
`password` is fine for a local copy on your machine; do not put it in the example file
or push it to GitHub. The server logs a warning on startup when a connection uses `password`.

## 3. Set the database password

**Option A — environment variable (preferred, especially if you share the repo):**

```powershell
[System.Environment]::SetEnvironmentVariable("IFS_DEV_DB_PASSWORD","yourpassword","User")
```

Then in `connections.json`:

```json
"passwordEnv": "IFS_DEV_DB_PASSWORD"
```

Close and reopen your terminal (and Cursor) after setting the env var.

**Option B — plain password in `connections.json` (local only):**

```json
"password": "yourpassword"
```

You can omit `passwordEnv` when `password` is set. Use this only in your private
gitignored `connections.json`, not in anything you copy to colleagues or commit.

## 4. Point Cursor at this server

In your project's `.cursor/mcp.json` (or Cursor's global MCP settings):

```json
{
  "mcpServers": {
    "kh-plsql-connect": {
      "command": "node",
      "args": ["C:\\path\\to\\kh-plsql-connect\\dist\\index.js"],
      "env": {
        "ORACLE_MCP_CONFIG": "C:\\path\\to\\kh-plsql-connect\\config\\connections.json"
      }
    }
  }
}
```

Restart Cursor. You should see `kh-plsql-connect` listed as an available MCP server.

## 5. Try it

In Cursor chat:
- "List available Oracle connections"
- "Using ifs_dev, search objects matching CUSTOMER_ORDER%"
- "Using ifs_dev, describe FND_USER (and show the _RTB keys)"
- "Using ifs_dev, show the spec of CUSTOMER_ORDER_API"
- "Using ifs_dev, run: SELECT COUNT(*) FROM fnd_user WHERE active = 'TRUE'"

On an IFS Cloud schema always pass a tight LIKE pattern. `list_tables` / `list_procedures`
without a pattern are capped and will warn.

## Tools

| Tool | Use |
|------|-----|
| `list_connections` / `test_connection` | Discover and ping named DBs |
| `execute_query` | Single SELECT/WITH, row-capped |
| `explain_query` | Plan for a single SELECT |
| `search_objects` | Best first browse step — required LIKE pattern |
| `list_tables` | Tables/views; `kind` can be `rtb`, `tab`, or `lu` |
| `list_procedures` | Packages; `kind` can be `api`, `sys`, `clf`, `svc`, or `rpi` |
| `describe_table` | Columns + constraints; `_TAB` views pick up `_RTB` keys |
| `describe_procedure` | `USER_ARGUMENTS` for `PACKAGE.METHOD` |
| `get_procedure_source` | Spec/body split, line-capped |
| `execute_dml` / `execute_plsql` / `execute_procedure` | Writes (gated) |

## Safety model

- **Read-only is the recommended default.** `mode: "readonly"` blocks `execute_dml`, write/DDL PL/SQL, and `execute_procedure`.
- **PL/SQL execution is opt-in** — `allowPlsql: false` blocks `execute_plsql` and `execute_procedure` entirely.
- **Dangerous statements are flagged anywhere in a block** (DROP, TRUNCATE, ALTER SYSTEM, EXECUTE IMMEDIATE, GRANT/REVOKE, UPDATE/DELETE without WHERE), including inside `BEGIN ... END;`.
- **`execute_query` accepts one SELECT/WITH only.** Stacked statements and `WITH ... INSERT` are rejected.
- **Every write auto-commits individually.** Pooled connections are opened fresh per tool call and closed right after.
- **Query timeout** (`queryTimeoutSeconds`) is applied to every execute.

This is a safety net, not a substitute for correct DB-level user privileges. The DB user
in your config should itself only have the grants it actually needs. An `IFSAPP` +
`readwrite` + `allowPlsql` connection can change a live Use Place.

## Roadmap

- [ ] OUT/INOUT bind parameters for stored procedures (currently IN-only; use `describe_procedure` to inspect them)
- [ ] Live config reload (no Cursor restart needed to pick up new connections)
- [ ] Cross-call transactions (each statement currently auto-commits on its own)
- [ ] Optional packaging so Node.js isn't a hard prerequisite for teammates
- [ ] Wallet / `tnsnames.ora` alias support (currently only `host` + `port` + `serviceName`, `sid`, or a raw `connectionString`)
- [ ] A UI (currently CLI/config-driven only)

---

Copyright (c) 2026 Kanchana Henarath. Licensed under MIT. See `LICENSE`.
