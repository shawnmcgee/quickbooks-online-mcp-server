#!/usr/bin/env node
// Smoke test for the built stdio server: starts dist/index.js the way Claude
// Desktop does (a child process speaking MCP over stdin/stdout) and checks it
// end to end without Claude in the loop.
//
// Usage (after `npm run build`):
//   node scripts/sandbox-smoke.mjs          offline: start, list tools, check stdout stays clean
//   node scripts/sandbox-smoke.mjs --live   also call read-only tools against the sandbox company
//
// Offline mode runs against an isolated, non-existent token store with dummy
// credentials, so it never reads your .env and never contacts Intuit. The
// QUICKBOOKS_DISABLE_* flags from your shell are passed through, so the
// toggles can be checked too, e.g. QUICKBOOKS_DISABLE_DELETE=true.
//
// Live mode lets the server read its own config exactly as it would under
// Claude Desktop (repo .env, or QUICKBOOKS_TOKEN_STORE_PATH). It refuses to run
// unless that config points at SANDBOX and already holds a refresh token and
// realm ID: without them the stock server starts its interactive OAuth flow
// inside the stdio process. Only read tools are called.
//
// This script never prints tokens or the client secret.

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(repoRoot, "dist", "index.js");
const live = process.argv.includes("--live");
const CALL_TIMEOUT_MS = 60_000;

const results = [];
const record = (ok, label, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
};

// Mirrors the server's config resolution (src/clients/quickbooks-client.ts:28-41):
// the token store file is read with override, so a key present in the file
// beats the same key in the process env.
function effectiveConfig() {
  const storePath =
    process.env.QUICKBOOKS_TOKEN_STORE_PATH?.trim() || path.join(repoRoot, ".env");
  let fromFile = {};
  try {
    fromFile = dotenv.parse(fs.readFileSync(storePath));
  } catch {
    /* no store file: env only */
  }
  const get = (name) => (name in fromFile ? fromFile[name] : process.env[name])?.trim() || "";
  return { storePath, get };
}

const isPlaceholder = (v) => !v || /^your_.*_here$/.test(v);

function categoryOf(toolName) {
  const m = /^(create|update|delete)[_-]/.exec(toolName);
  return m ? m[1] : "read";
}

function serverEnv() {
  if (live) return { ...process.env };
  const isolatedStore = path.join(os.tmpdir(), `qbo-smoke-${process.pid}`, "absent.env");
  const env = {
    QUICKBOOKS_CLIENT_ID: "smoke-offline-client-id",
    QUICKBOOKS_CLIENT_SECRET: "smoke-offline-client-secret",
    QUICKBOOKS_ENVIRONMENT: "sandbox",
    QUICKBOOKS_TOKEN_STORE_PATH: isolatedStore,
  };
  for (const name of ["QUICKBOOKS_DISABLE_WRITE", "QUICKBOOKS_DISABLE_UPDATE", "QUICKBOOKS_DISABLE_DELETE"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function texts(result) {
  return (result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text);
}

// Stock tools signal failure in text only; none of them sets isError.
function failureText(result) {
  if (result?.isError) return texts(result).join(" ").slice(0, 300) || "isError set";
  const first = texts(result)[0] ?? "";
  return /^(Error|Invalid)/.test(first) ? first.slice(0, 300) : null;
}

async function callRead(client, name, params) {
  const result = await client.callTool({ name, arguments: { params } }, undefined, {
    timeout: CALL_TIMEOUT_MS,
  });
  const failure = failureText(result);
  if (failure) throw new Error(failure);
  return result;
}

async function liveChecks(client) {
  try {
    const info = JSON.parse(texts(await callRead(client, "get_company_info", {}))[0]);
    record(true, "get_company_info", `"${info?.CompanyName}" (${info?.Country ?? "country n/a"})`);
  } catch (e) {
    record(false, "get_company_info", e.message);
  }

  try {
    const out = texts(await callRead(client, "search_accounts", { criteria: { limit: 10 } }));
    record(true, "search_accounts", out[0]);
  } catch (e) {
    record(false, "search_accounts", e.message);
  }

  try {
    const year = new Date().getFullYear();
    const out = texts(
      await callRead(client, "get_profit_and_loss", { start_date: `${year}-01-01`, end_date: `${year}-12-31` })
    );
    const header = JSON.parse(out[1])?.Header ?? {};
    record(true, "get_profit_and_loss", `${header.ReportName} ${header.StartPeriod}..${header.EndPeriod} ${header.Currency ?? ""}`.trim());
  } catch (e) {
    record(false, "get_profit_and_loss", e.message);
  }
}

async function main() {
  if (!fs.existsSync(serverEntry)) {
    console.error(`Missing ${serverEntry}. Run \`npm run build\` first.`);
    process.exit(2);
  }

  if (live) {
    const { storePath, get } = effectiveConfig();
    const environment = get("QUICKBOOKS_ENVIRONMENT") || "sandbox";
    const missing = [
      "QUICKBOOKS_CLIENT_ID",
      "QUICKBOOKS_CLIENT_SECRET",
      "QUICKBOOKS_REFRESH_TOKEN",
      "QUICKBOOKS_REALM_ID",
    ].filter((n) => isPlaceholder(get(n)));
    console.log(`Config: ${storePath} (plus process env), environment=${environment}`);
    if (environment !== "sandbox") {
      console.error("Refusing --live: QUICKBOOKS_ENVIRONMENT is not sandbox. Development is sandbox only.");
      process.exit(2);
    }
    if (missing.length) {
      console.error(`Refusing --live: not set: ${missing.join(", ")}. Run \`npm run auth\` first.`);
      process.exit(2);
    }
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: serverEnv(),
    stderr: "inherit",
  });
  // Anything on the server's stdout that is not a JSON-RPC message lands here.
  const protocolErrors = [];
  const client = new Client({ name: "qbo-sandbox-smoke", version: "0.0.0" });
  client.onerror = (e) => protocolErrors.push(e);

  try {
    await client.connect(transport);
    const version = client.getServerVersion();
    record(true, "server started over stdio", `${version?.name} ${version?.version}`);

    const { tools } = await client.listTools();
    const counts = { create: 0, update: 0, delete: 0, read: 0 };
    for (const t of tools) counts[categoryOf(t.name)]++;
    record(
      tools.length > 0,
      "tools/list",
      `${tools.length} tools (create ${counts.create}, update ${counts.update}, delete ${counts.delete}, read ${counts.read})`
    );

    for (const [flag, category] of [
      ["QUICKBOOKS_DISABLE_WRITE", "create"],
      ["QUICKBOOKS_DISABLE_UPDATE", "update"],
      ["QUICKBOOKS_DISABLE_DELETE", "delete"],
    ]) {
      if (!live && process.env[flag] === "true") {
        record(counts[category] === 0, `${flag}=true hides ${category} tools`, `${counts[category]} present`);
      }
    }

    if (live) await liveChecks(client);
  } catch (e) {
    record(false, "smoke run", e?.message ?? String(e));
  } finally {
    await client.close().catch(() => {});
  }

  record(
    protocolErrors.length === 0,
    "stdout carried only MCP messages",
    protocolErrors.length ? `${protocolErrors.length} non-protocol write(s), first: ${protocolErrors[0]?.message}` : ""
  );

  const failed = results.filter((ok) => !ok).length;
  console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
  process.exit(failed ? 1 : 0);
}

main();
