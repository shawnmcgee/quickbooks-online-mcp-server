# Phase 2: token and company store

**Goal:** keep connected companies and their refresh tokens in a store that
survives restarts, token rotation and extension updates, with every rotated
token saved safely. The server does not use the store yet. Phase 3 wires it
in, together with the `company` argument.

## Decisions applied

| Decision | Where |
|----------|-------|
| Tokens in the OS credential store (Windows Credential Manager), chosen as option A | `src/store/secret-store.ts` |
| The store holds tokens and the company registry only; no dotenv | `src/store/*`. Nothing there reads or writes `.env`. |
| A rotated-out refresh token counts as invalid immediately | Saves are retried and reported, never dropped; the client never falls back to an older token |
| Failed saves are retried on Windows, and a persistent failure reaches the tool result | Retries: `withRetry` and `CompanyConnection`. Surfacing: `saveWarning` and `flushPendingSave()`, which the Phase 3 wrapper will call |
| Refresh-on-start for every company, plus a reconnect path | `CompanyClients.refreshAll()` and `ReconnectRequiredError`. Phase 3 calls it at startup; Phase 4 adds the reconnect flow itself. |
| `startOAuthFlow()` is not reused | A store-backed client never starts it (`quickbooks-client.ts`) |

## Layout

| What | Where | Secret? |
|------|-------|---------|
| Company list (name, realm ID, environment, status) | `%LOCALAPPDATA%\qbo-mcp\companies.json`. macOS: `~/Library/Application Support/qbo-mcp`. Linux: `$XDG_DATA_HOME/qbo-mcp`. Override with `QUICKBOOKS_STORE_DIR`. | No |
| One refresh token per company | Windows Credential Manager, service `qbo-mcp`, account `<environment>:<realmId>` | Yes |

- **Outside the install directory.** Both locations sit outside the extension's
  install directory, so updates and reinstalls don't touch them.
- **Why LOCALAPPDATA rather than APPDATA.** Roaming profiles copy APPDATA to a
  domain server; LOCALAPPDATA stays on the machine.

## How it fits together

```
CompanyClients (one QuickbooksClient per company in the configured environment)
  └─ QuickbooksClient({ ..., store: CompanyConnection })   ← small hook in the upstream client
       ├─ rotation          → connection.saveRefreshToken()   (retried, ordered, newest wins)
       ├─ token rejected    → connection.loadRefreshToken()   (another process may have rotated it)
       └─ token missing/dead → connection.reconnectRequired() (flags the company; no browser)
CompanyStore
  ├─ CompanyRegistry  → companies.json   (atomic write: temp file, flush, rename; retried)
  └─ SecretStore      → Credential Manager via @napi-rs/keyring (no plaintext fallback)
```

**Changes to the upstream client.** `src/clients/quickbooks-client.ts` gets
+26/−4 lines: an optional `store` in the constructor, plus four places that
use it when it is set. Without a store, it behaves exactly as before. All 639
original tests still pass.

### Write ordering and crash safety

- **Connect:** the token is written first, then the registry entry. A crash in
  between leaves at most an orphan credential, never a listed company with no
  token.
- **Remove:** the reverse order: registry entry first, then the token.
- **Registry writes:** each write goes to a fresh temp file, is flushed to
  disk, then renamed over the target. Windows `EPERM`, `EBUSY` and `EACCES`
  errors are retried 4 times with backoff (100, 200, 400, 800 ms). A corrupt or
  newer-format registry is reported, never overwritten.
- **Token saves:**
  - They run one at a time and always write the **newest** pending token, so a
    slow save of an older token can never land after a newer one.
  - If every retry fails, the new token stays in memory. `saveWarning` then
    returns text for the tool result ("…could not be saved… If Claude or the
    computer restarts before it is saved, "X" will need to be reconnected"),
    and `flushPendingSave()` tries again on the next call.

### Status and reconnect

- **When a company is flagged.** A token that Intuit rejects (HTTP 400/401 or
  `invalid_grant`), or a company with no saved token, is flagged
  `needs_reconnect` in the registry. The error is a `ReconnectRequiredError`
  naming the company, in sandbox and production alike.
- **Transient failures** (network, Intuit 5xx) never change the status.
- **Recovery.** A later successful refresh marks the company `connected` again.
- **Other environment.** Companies registered under the other environment are
  not loaded, because the configured app keys can't refresh their tokens.

## Tests

- **New unit tests:** 85 across 6 files, with 100% coverage of `src/store/*`.
- **Windows-only test.** It round-trips a real credential through Windows
  Credential Manager. It is skipped on Linux and **runs on the
  `windows-latest` CI job**.
- **Full suite:** 41 suites; 723 passed and 1 skipped (Windows only). Lint and
  build are clean.
- **Server unchanged:** `scripts/sandbox-smoke.mjs` still reports 142 tools,
  the toggles still work, and stdout is clean.

> Note: Jest's coverage report omits `src` files that no test imports, so the
> 100% global gate would **not** catch a new, untested module. Every new
> module here has its own tests.

## Live check on Windows (developer)

Use a sandbox company only. Do this **after** the Phase 1 checks, because step
2 moves the token out of `.env`.

1. **Update the checkout:** `git checkout claude/charming-hypatia-8nypcr`,
   `git pull`, then `npm ci`. This installs the Windows Credential Manager
   binary `@napi-rs/keyring-win32-x64-msvc` and builds `dist/`.
2. **Import the token:** `node scripts\company-store.mjs import-env`. Expect
   these lines:
   - `Saved ...`
   - `Removed QUICKBOOKS_REFRESH_TOKEN from ...\.env`
   - `OK <name>`
   - `Named the company "<sandbox company name>"`

   From now on, **don't use the stock server in Claude Desktop**. Its `.env`
   has no token, so it would fall into the old browser flow. Remove the
   `quickbooks` entry added in Phase 1; Phase 3 provides the replacement.
3. **Check the registry:** run `node scripts\company-store.mjs list`. The
   company should show as `connected`.
4. **Check Credential Manager.** In Control Panel → Credential Manager →
   Windows Credentials there should be a generic credential mentioning
   `qbo-mcp`; the exact label is UNVERIFIED. Also open
   `%LOCALAPPDATA%\qbo-mcp\companies.json`: it should contain no token.
5. **Restart check:** run `node scripts\company-store.mjs refresh` twice. Each
   run is a fresh process, which simulates a restart. Both should print
   `OK`.
   - When Intuit rotates the token (roughly daily; UNVERIFIED), the run also
     prints `[qbo-client] Refresh token rotated and saved to the company store`.
     Running `refresh` again the next day exercises a real rotation.
6. **Dead-token path:**
   1. In Credential Manager, edit that credential's password to any other
      text.
   2. `refresh` should print `RECONNECT ...` and exit 1.
   3. `list` should show `NEEDS RECONNECT`.
   4. To recover until Phase 4 exists: run `npm run auth` (it opens the
      browser again, because `.env` no longer has a token), then
      `import-env`.

**Send back:** the output of steps 2–6, which contains no tokens.

## Left for later phases

- **Phase 3:**
  - make the server use `CompanyClients`, with the `company` argument and exact
    matching;
  - call `refreshAll()` at startup;
  - make the wrapper call `flushPendingSave()` and prepend `saveWarning` and
    "Applied to";
  - turn off the legacy `.env` load in store mode.
- **Phase 4:** the connect/reconnect flow, which writes through
  `CompanyStore.addCompany()`. The client's "refresh token expires in N days"
  hint still says `npm run auth`; point it at reconnect.
- **Phase 5:** bundle the Windows binary (`@napi-rs/keyring-win32-x64-msvc`,
  plus `-arm64-msvc` if ARM laptops matter) in the `.mcpb`. Confirm that Claude
  Desktop's Node loads it.
- **Known limit:** two server processes changing the company list at the same
  instant can drop an entry. Its token stays in Credential Manager, and
  reconnecting fixes it. Writes are rare (connect and remove), so I didn't add
  a lock file.
