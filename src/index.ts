#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { asArgs, optionalBoolean, optionalNumber, optionalString, requireString } from "./args.js";
import { loadConfig } from "./config.js";
import { closeAllPools } from "./oracleClient.js";
import { listConnections, testConnectionTool } from "./tools/connections.js";
import { executeDml, executeQuery } from "./tools/query.js";
import { executePlsql, executeProcedure, explainQuery } from "./tools/plsql.js";
import {
  describeProcedure,
  describeTable,
  getProcedureSource,
  listProcedures,
  listTables,
  searchObjects,
} from "./tools/schema.js";

const config = loadConfig();

const server = new Server(
  { name: "kh-plsql-connect", version: "0.2.0" },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: "list_connections",
    description:
      "List all configured Oracle database connections and their capability modes (readonly/readwrite, PL/SQL allowed).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "test_connection",
    description: "Test connectivity to a named connection and return basic server info.",
    inputSchema: {
      type: "object",
      properties: { connection: { type: "string", description: "Connection name from list_connections" } },
      required: ["connection"],
      additionalProperties: false,
    },
  },
  {
    name: "execute_query",
    description: "Run a single SELECT (or WITH) query against a named connection and return rows. Not for DML.",
    inputSchema: {
      type: "object",
      properties: {
        connection: { type: "string" },
        sql: { type: "string", description: "A single SELECT/WITH statement only." },
        maxRows: { type: "number", description: "Optional row cap; defaults to server setting (max 2000)." },
      },
      required: ["connection", "sql"],
      additionalProperties: false,
    },
  },
  {
    name: "execute_dml",
    description:
      "Run INSERT/UPDATE/DELETE/MERGE against a named connection. Requires mode=readwrite. " +
      "Dangerous statements (DROP/TRUNCATE/ALTER SYSTEM/unqualified UPDATE-DELETE) need allowDangerous plus confirmDangerous=true.",
    inputSchema: {
      type: "object",
      properties: {
        connection: { type: "string" },
        sql: { type: "string" },
        confirmDangerous: { type: "boolean", description: "Set true to proceed with a flagged statement." },
      },
      required: ["connection", "sql"],
      additionalProperties: false,
    },
  },
  {
    name: "execute_plsql",
    description:
      "Run a PL/SQL block (or DDL such as CREATE PROCEDURE/FUNCTION). Requires allowPlsql. " +
      "Write/DDL blocks also require mode=readwrite. Dangerous statements need allowDangerous plus confirmDangerous=true.",
    inputSchema: {
      type: "object",
      properties: {
        connection: { type: "string" },
        block: { type: "string", description: "A full PL/SQL block, e.g. BEGIN ... END; or CREATE OR REPLACE ..." },
        confirmDangerous: { type: "boolean" },
      },
      required: ["connection", "block"],
      additionalProperties: false,
    },
  },
  {
    name: "execute_procedure",
    description:
      "Call a stored procedure by name with IN bind parameters. Requires allowPlsql and mode=readwrite. " +
      "OUT parameters are not yet supported.",
    inputSchema: {
      type: "object",
      properties: {
        connection: { type: "string" },
        procedureName: { type: "string", description: "e.g. PKG_ORDERS.CANCEL_ORDER" },
        bindParams: {
          type: "object",
          description: 'Named bind parameters, e.g. { "p_order_id": 123 }',
          additionalProperties: true,
        },
      },
      required: ["connection", "procedureName"],
      additionalProperties: false,
    },
  },
  {
    name: "list_tables",
    description:
      "List tables and views. Always pass a tight LIKE pattern on large IFS schemas (e.g. CUSTOMER_ORDER%). " +
      "kind=rtb|tab|lu filters editioning objects. Results are capped (default 100).",
    inputSchema: {
      type: "object",
      properties: {
        connection: { type: "string" },
        pattern: { type: "string", description: "LIKE pattern, e.g. CUSTOMER_ORDER% or FND_USER%" },
        objectType: { type: "string", description: "TABLE or VIEW" },
        kind: { type: "string", description: "all | rtb | tab | lu" },
        owner: { type: "string", description: "Schema owner; defaults to the connected user" },
        maxRows: { type: "number", description: "Cap (default 100, max 500)" },
      },
      required: ["connection"],
      additionalProperties: false,
    },
  },
  {
    name: "describe_table",
    description:
      "Get columns, constraints, and related IFS names (_RTB / _TAB / LU view). " +
      "For editioning views, constraints are read from the matching _RTB.",
    inputSchema: {
      type: "object",
      properties: {
        connection: { type: "string" },
        tableName: { type: "string" },
        owner: { type: "string" },
      },
      required: ["connection", "tableName"],
      additionalProperties: false,
    },
  },
  {
    name: "list_procedures",
    description:
      "List procedures, functions, and packages. Always pass a tight LIKE pattern on IFS schemas " +
      "(e.g. CUSTOMER_ORDER%) or kind=api|sys|clf|svc|rpi. Results are capped (default 100).",
    inputSchema: {
      type: "object",
      properties: {
        connection: { type: "string" },
        pattern: { type: "string" },
        kind: { type: "string", description: "all | api | sys | clf | svc | rpi" },
        owner: { type: "string" },
        maxRows: { type: "number" },
      },
      required: ["connection"],
      additionalProperties: false,
    },
  },
  {
    name: "search_objects",
    description:
      "Search USER/ALL_OBJECTS with a required LIKE pattern. Best first step on IFS (e.g. pattern CUSTOMER_ORDER%, objectType PACKAGE).",
    inputSchema: {
      type: "object",
      properties: {
        connection: { type: "string" },
        pattern: { type: "string", description: "Required LIKE pattern" },
        objectType: { type: "string", description: "e.g. PACKAGE, TABLE, VIEW, PACKAGE BODY" },
        owner: { type: "string" },
        maxRows: { type: "number" },
      },
      required: ["connection", "pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "get_procedure_source",
    description:
      "Get PL/SQL source split into spec and body. Prefer sourceType=spec first on large IFS packages. " +
      "Each part is line-capped (default 3000).",
    inputSchema: {
      type: "object",
      properties: {
        connection: { type: "string" },
        objectName: { type: "string" },
        sourceType: { type: "string", description: "spec | body | all (default all)" },
        maxLines: { type: "number" },
        owner: { type: "string" },
      },
      required: ["connection", "objectName"],
      additionalProperties: false,
    },
  },
  {
    name: "describe_procedure",
    description:
      "List argument metadata (IN/OUT, type, position, overload) for a procedure, function, or package method. " +
      "Use PACKAGE_NAME.METHOD_NAME for a single method.",
    inputSchema: {
      type: "object",
      properties: {
        connection: { type: "string" },
        objectName: { type: "string", description: "PACKAGE, METHOD, or PACKAGE.METHOD" },
        owner: { type: "string" },
      },
      required: ["connection", "objectName"],
      additionalProperties: false,
    },
  },
  {
    name: "explain_query",
    description: "Get the execution plan for a single SELECT statement without running it.",
    inputSchema: {
      type: "object",
      properties: { connection: { type: "string" }, sql: { type: "string" } },
      required: ["connection", "sql"],
      additionalProperties: false,
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = asArgs(rawArgs);

  try {
    let result: unknown;

    switch (name) {
      case "list_connections":
        result = listConnections(config);
        break;
      case "test_connection":
        result = await testConnectionTool(config, requireString(args, "connection"));
        break;
      case "execute_query":
        result = await executeQuery(
          config,
          requireString(args, "connection"),
          requireString(args, "sql"),
          optionalNumber(args, "maxRows")
        );
        break;
      case "execute_dml":
        result = await executeDml(
          config,
          requireString(args, "connection"),
          requireString(args, "sql"),
          optionalBoolean(args, "confirmDangerous")
        );
        break;
      case "execute_plsql":
        result = await executePlsql(
          config,
          requireString(args, "connection"),
          requireString(args, "block"),
          optionalBoolean(args, "confirmDangerous")
        );
        break;
      case "execute_procedure":
        result = await executeProcedure(
          config,
          requireString(args, "connection"),
          requireString(args, "procedureName"),
          (args.bindParams as Record<string, unknown>) ?? {}
        );
        break;
      case "list_tables":
        result = await listTables(config, requireString(args, "connection"), {
          pattern: optionalString(args, "pattern"),
          objectType: optionalString(args, "objectType"),
          kind: optionalString(args, "kind"),
          owner: optionalString(args, "owner"),
          maxRows: optionalNumber(args, "maxRows"),
        });
        break;
      case "describe_table":
        result = await describeTable(
          config,
          requireString(args, "connection"),
          requireString(args, "tableName"),
          optionalString(args, "owner")
        );
        break;
      case "list_procedures":
        result = await listProcedures(config, requireString(args, "connection"), {
          pattern: optionalString(args, "pattern"),
          kind: optionalString(args, "kind"),
          owner: optionalString(args, "owner"),
          maxRows: optionalNumber(args, "maxRows"),
        });
        break;
      case "search_objects":
        result = await searchObjects(config, requireString(args, "connection"), {
          pattern: requireString(args, "pattern"),
          objectType: optionalString(args, "objectType"),
          owner: optionalString(args, "owner"),
          maxRows: optionalNumber(args, "maxRows"),
        });
        break;
      case "get_procedure_source":
        result = await getProcedureSource(
          config,
          requireString(args, "connection"),
          requireString(args, "objectName"),
          {
            sourceType: optionalString(args, "sourceType"),
            maxLines: optionalNumber(args, "maxLines"),
            owner: optionalString(args, "owner"),
          }
        );
        break;
      case "describe_procedure":
        result = await describeProcedure(
          config,
          requireString(args, "connection"),
          requireString(args, "objectName"),
          optionalString(args, "owner")
        );
        break;
      case "explain_query":
        result = await explainQuery(config, requireString(args, "connection"), requireString(args, "sql"));
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

process.on("SIGINT", async () => {
  await closeAllPools();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await closeAllPools();
  process.exit(0);
});

main().catch((err) => {
  console.error("Fatal error starting kh-plsql-connect:", err);
  process.exit(1);
});
