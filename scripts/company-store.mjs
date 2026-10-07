#!/usr/bin/env node
// Developer tool for the company store (src/store), for testing it before the
// in-conversation connect flow exists. Run `npm run build` first.
//
//   node scripts/company-store.mjs list
//   node scripts/company-store.mjs import-env [--name "Display name"]
//   node scripts/company-store.mjs refresh
//   node scripts/company-store.mjs remove <realm-id>
//
// import-env MOVES the sandbox token that `npm run auth` saved in .env into
// the store: the token goes to the OS credential store, the company to the
// registry, and the QUICKBOOKS_REFRESH_TOKEN line is deleted from .env. A
// refresh token is dead as soon as Intuit rotates it, so two copies would
// soon break one another. Sandbox only.
//
// Client ID and secret come from .env, as for the stock server. The store
// location honours QUICKBOOKS_STORE_DIR. Tokens are never printed.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = (p) => new URL(`../dist/${p}`, import.meta.url).href;

for (const p of ["store/company-registry.js", "clients/quickbooks-client.js"]) {
  if (!fs.existsSync(path.join(repoRoot, "dist", p))) {
    console.error("Missing dist/. Run `npm run build` first.");
    process.exit(2);
  }
}

const { CompanyRegistry } = await import(dist("store/company-registry.js"));
const { CompanyStore } = await import(dist("store/company-store.js"));
const { KeyringSecretStore } = await import(dist("store/secret-store.js"));
const { writeFileAtomic } = await import(dist("store/atomic-file.js"));

const registry = CompanyRegistry.atDefaultLocation();
const store = new CompanyStore(registry, new KeyringSecretStore());

const [command, ...rest] = process.argv.slice(2);
const option = (name) => {
  const i = rest.indexOf(name);
  return i === -1 ? undefined : rest[i + 1];
};

function describe(c) {
  const status = c.status === "connected" ? "connected" : `NEEDS RECONNECT${c.statusDetail ? ` (${c.statusDetail})` : ""}`;
  return `${c.name}  [${c.environment}, realm ${c.realmId}]  ${status}`;
}

async function loadClients() {
  // Importing the client module loads .env (client ID and secret) exactly as
  // the stock server does.
  const { QuickbooksClient } = await import(dist("clients/quickbooks-client.js"));
  const { CompanyClients } = await import(dist("store/company-clients.js"));
  const environment = process.env.QUICKBOOKS_ENVIRONMENT || "sandbox";
  if (environment !== "sandbox") throw new Error("QUICKBOOKS_ENVIRONMENT is not sandbox. Development is sandbox only.");
  const clients = new CompanyClients({
    store,
    clientId: process.env.QUICKBOOKS_CLIENT_ID,
    clientSecret: process.env.QUICKBOOKS_CLIENT_SECRET,
    environment,
    createClient: (config) => new QuickbooksClient(config),
  });
  await clients.load();
  return clients;
}

async function refresh() {
  const clients = await loadClients();
  if (clients.list().length === 0) console.log("No sandbox companies in the store.");
  let failed = 0;
  for (const outcome of await clients.refreshAll()) {
    if (outcome.ok) {
      console.log(`OK      ${outcome.company.name}`);
    } else {
      failed++;
      console.log(`${outcome.needsReconnect ? "RECONNECT" : "FAILED "} ${outcome.company.name}: ${outcome.error}`);
    }
  }
  return { clients, failed };
}

function companyName(client, realmId) {
  return new Promise((resolve) => {
    client.getQuickbooks().getCompanyInfo(realmId, (err, info) => resolve(err ? undefined : info?.CompanyName));
  });
}

async function importEnv() {
  const envPath = process.env.QUICKBOOKS_TOKEN_STORE_PATH?.trim() || path.join(repoRoot, ".env");
  const text = fs.readFileSync(envPath, "utf8");
  const env = dotenv.parse(text);
  const environment = env.QUICKBOOKS_ENVIRONMENT || "sandbox";
  const refreshToken = env.QUICKBOOKS_REFRESH_TOKEN?.trim();
  const realmId = env.QUICKBOOKS_REALM_ID?.trim();
  if (environment !== "sandbox") throw new Error(`${envPath} is not for sandbox. Development is sandbox only.`);
  if (!refreshToken || !realmId || /^your_/.test(refreshToken) || /^your_/.test(realmId)) {
    throw new Error(`${envPath} has no refresh token and realm ID. Run \`npm run auth\` first.`);
  }

  const givenName = option("--name");
  const record = await store.addCompany({
    name: givenName || `Sandbox company ${realmId}`,
    realmId,
    environment,
    refreshToken,
  });
  console.log(`Saved "${record.name}" (realm ${realmId}) to the store: ${registry.filePath} and the OS credential store.`);

  // Remove the .env copy BEFORE the first refresh rotates the token.
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const kept = text.split(/\r?\n/).filter((line) => !/^\s*(export\s+)?QUICKBOOKS_REFRESH_TOKEN\s*=/.test(line));
  try {
    await writeFileAtomic(envPath, kept.join(eol));
  } catch (err) {
    throw new Error(
      `Could not remove QUICKBOOKS_REFRESH_TOKEN from ${envPath} (${err.message}). Delete that line by hand ` +
        "before running anything else, or the two copies will invalidate each other."
    );
  }
  console.log(`Removed QUICKBOOKS_REFRESH_TOKEN from ${envPath}.`);

  const { clients, failed } = await refresh();
  if (failed || givenName) return failed;
  const name = await companyName(clients.get(realmId).client, realmId);
  if (name) {
    await registry.upsert({ name, realmId, environment });
    console.log(`Named the company "${name}" from QuickBooks.`);
  }
  return 0;
}

async function main() {
  switch (command) {
    case "list": {
      const companies = await registry.list();
      console.log(`Registry: ${registry.filePath}`);
      console.log(companies.length ? companies.map(describe).join("\n") : "(no companies)");
      return 0;
    }
    case "import-env":
      return (await importEnv()) ? 1 : 0;
    case "refresh":
      return (await refresh()).failed ? 1 : 0;
    case "remove": {
      const realmId = rest[0];
      if (!realmId) throw new Error("Usage: remove <realm-id>");
      const removed = await store.removeCompany("sandbox", realmId);
      console.log(removed ? `Removed realm ${realmId} and its token.` : `Realm ${realmId} was not registered; its token (if any) was removed.`);
      return 0;
    }
    default:
      console.error("Usage: node scripts/company-store.mjs list | import-env [--name NAME] | refresh | remove <realm-id>");
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
);
