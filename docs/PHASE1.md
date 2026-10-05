# Phase 1: stock server against a sandbox company

**Goal:** the unmodified upstream server works against a QuickBooks sandbox
company. Nothing under `src/` changes in this phase.

## Status

| Check | Where | Result |
|-------|-------|--------|
| Server starts over stdio and completes the MCP handshake | cloud session | PASS |
| `tools/list` returns all tools | cloud session | PASS: 142 tools (25 create, 26 update, 20 delete, 71 read) |
| `QUICKBOOKS_DISABLE_DELETE=true` | cloud session | PASS: 122 tools, 0 delete |
| All three `QUICKBOOKS_DISABLE_*=true` | cloud session | PASS: 71 tools, read only |
| Nothing but MCP messages on stdout at startup and listing | cloud session | PASS |
| Stray stdout output is detected (detector self-check) | cloud session | PASS: one injected line reported, session survived |
| Test suite after the phase | cloud session | PASS: 35/35 suites, 639/639 tests; lint clean |
| Live read calls against a sandbox company | **developer machine** | **Pending** (see below) |
| Claude Desktop answers from the sandbox company, also after a restart | **developer machine** | **Pending** |

**Why the live checks are pending.** The cloud session can't reach Intuit:
its network policy denies `oauth.platform.intuit.com` and
`sandbox-quickbooks.api.intuit.com`, and it has no sandbox credentials. The
OAuth handshake also needs a person to sign in through a browser on the
machine that is listening on `localhost:8000`.

## The smoke script

`scripts/sandbox-smoke.mjs` starts `dist/index.js` the way Claude Desktop
does: a child process speaking MCP over stdin/stdout. It never prints tokens
or the client secret.

```
node scripts/sandbox-smoke.mjs          # offline: no .env read, no network
node scripts/sandbox-smoke.mjs --live   # also calls 3 read-only tools on the sandbox company
```

**Offline mode** uses dummy credentials and an isolated token-store path, so
it can run anywhere. Set `QUICKBOOKS_DISABLE_*` in the shell to check the
toggles.

**`--live` mode** lets the server read its own config, as it would under
Claude Desktop. It **refuses to run** unless that config:

- points at **sandbox**; and
- already holds a refresh token and a realm ID.

Without them, the stock server would start its interactive OAuth flow inside
the stdio process. `--live` calls only these read-only tools:

- `get_company_info`
- `search_accounts` (limit 10)
- `get_profit_and_loss` (this calendar year)

Later phases will reuse this script as a regression check.

## Runbook: live check on Windows

Sandbox only. Don't use production keys or a real client's company.

1. **Prerequisites.** You need:
   - Node.js 22, the version CI uses;
   - Git;
   - an Intuit Developer account with a **sandbox** company.
2. **Intuit app.** In the Intuit Developer Portal, create an app or open an
   existing one. Under the **Development** keys:
   - add the redirect URI `http://localhost:8000/callback`;
   - copy the Client ID and Client Secret.

   The README's "Sandbox Setup" has the menu names. The portal UI may have
   changed since; this is UNVERIFIED.
3. **Get the code.** In PowerShell:
   ```powershell
   git clone https://github.com/shawnmcgee/quickbooks-online-mcp-server.git
   cd quickbooks-online-mcp-server
   git checkout claude/charming-hypatia-8nypcr
   npm ci          # also builds dist/
   ```
4. **Create `.env`.** Copying the example avoids two Notepad and PowerShell
   problems: a hidden `.txt` extension, and UTF-16 encoding, which dotenv
   can't read.
   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```
   In Notepad:
   - fill in `QUICKBOOKS_CLIENT_ID` and `QUICKBOOKS_CLIENT_SECRET`;
   - keep `QUICKBOOKS_ENVIRONMENT=sandbox`;
   - **delete** the `QUICKBOOKS_REFRESH_TOKEN` and `QUICKBOOKS_REALM_ID`
     lines. Their placeholder values look like real ones, and the stock
     server would try to use them first.
5. **Authorize.** Run `npm run auth`. A browser opens. Sign in, choose the
   sandbox company and approve. The tokens are saved to `.env`.
   - The terminal shows the authorization URL and the callback URL, which
     includes a one-time code. Don't paste that output anywhere.
   - If you see `listen EAFNOSUPPORT ... :::8000`, IPv6 is disabled on that
     machine. The stock listener binds `::`. Phase 4's flow will bind
     `127.0.0.1`.
6. **Run the smoke test.** Run `node scripts\sandbox-smoke.mjs --live`. Every
   line should say `PASS`. The output contains the sandbox company's name and
   no secrets.
7. **Claude Desktop.** Open Settings → Developer → Edit Config and add:
   ```json
   {
     "mcpServers": {
       "quickbooks": {
         "command": "node",
         "args": ["C:\\full\\path\\to\\quickbooks-online-mcp-server\\dist\\index.js"]
       }
     }
   }
   ```
   - No `env` block is needed. The server reads `.env` next to the package,
     and `.env` would override an `env` block anyway (RECON §2).
   - Quit Claude Desktop **completely**, including the tray icon, then reopen
     it.
   - Ask it "Using QuickBooks, what is the company's name?" and then "Show
     this year's profit and loss from QuickBooks."
8. **Restart check.** Quit and reopen Claude Desktop, then ask again. It
   should still answer. The token is now read from `.env`, where the first
   refresh may already have written a rotated one.

**Send back:**
- the smoke-test output;
- whether steps 7 and 8 answered from the sandbox company.

**Never send:** `.env`, tokens, or the client secret.

### Alternative: run the live check in the cloud session

1. Allow `oauth.platform.intuit.com` and `sandbox-quickbooks.api.intuit.com`
   in the environment's network settings.
2. Provide these as environment secrets, not in chat:
   - `QUICKBOOKS_CLIENT_ID`
   - `QUICKBOOKS_CLIENT_SECRET`
   - `QUICKBOOKS_REFRESH_TOKEN`
   - `QUICKBOOKS_REALM_ID`

   Take the token and realm ID from a completed step 5.

**Caveat:** the first refresh in the cloud session rotates the token. After
that, treat the copy in your local `.env` as dead and run `npm run auth`
again before using it locally. Claude Desktop can't be checked from the cloud
session, so steps 7 and 8 stay on your machine either way.

## Findings during this phase

- **No IPv6, no auth listener.** The stock OAuth listener binds `::`
  (`src/clients/quickbooks-client.ts:392`). On a host without IPv6, `listen`
  fails with `EAFNOSUPPORT` before the browser opens. In the stdio server, the
  error comes back as the tool result text
  (`Error: Error: listen EAFNOSUPPORT ...`). Phase 4's flow should bind
  `127.0.0.1`.
- **Stock behaviour is otherwise as RECON described.** No source changes were
  needed to start, list tools, or apply the toggles.
