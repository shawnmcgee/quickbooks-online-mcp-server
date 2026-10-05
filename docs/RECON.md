# Phase 0 recon

Findings from reading the source at commit `fb2e3c2` (branch
`claude/charming-hypatia-8nypcr`), answering the five questions in
`PROJECT_BRIEF.md`. No code was changed in this phase. Line references are to
that commit.

Dependency versions as installed by `npm ci`: `node-quickbooks` 2.0.50,
`intuit-oauth` 4.2.5, `@modelcontextprotocol/sdk` 1.30.0, `dotenv` 16.6.1.

---

## 1. Where is the rotated refresh token written, and when?

**One writer:** `QuickbooksClient.saveTokensToEnv()`,
`src/clients/quickbooks-client.ts:424-485`. It is called from two places.

| # | Call site | When it runs | What it writes |
|---|-----------|--------------|----------------|
| W1 | `startOAuthFlow()` callback, `quickbooks-client.ts:330-336` | After the browser OAuth code exchange succeeds | `QUICKBOOKS_REFRESH_TOKEN` and `QUICKBOOKS_REALM_ID` |
| W2 | `refreshAccessToken()`, `quickbooks-client.ts:547-561` | After a successful refresh, **only if** Intuit returned a refresh token different from the in-memory one | Both keys again; the realm ID is unchanged |

**Target file.** `TOKEN_STORE_PATH` (`quickbooks-client.ts:28-35`) is either:

- `QUICKBOOKS_TOKEN_STORE_PATH`, which must be absolute and must come from the
  host process env. It is read before dotenv runs, so setting it inside `.env`
  has no effect.
- Otherwise `<module dir>/../../.env`, which is the package root (from
  `dist/clients/`).

**How the write works** (`quickbooks-client.ts:424-485`):

1. It reads the whole file and replaces the line starting with `NAME=`, or
   appends one if none matches (`429-439`).
2. For a regular file, it writes `<path>.tmp.<pid>` with mode `0o600` and then
   calls `renameSync` over the target (`473-484`). On failure it deletes the
   temp file and rethrows.
3. If the path is a symlink, it writes through to the target directly, which
   is deliberately **not** atomic (`444-471`).

**When refreshes (and so W2) happen.** Refresh is lazy: there is no background
timer.

- The access token is never persisted. So the **first tool call after every
  process start** refreshes, via `getInstance()` → `authenticate()` →
  `refreshAccessToken()` (`670-677`, `611-614`).
- After that, a refresh happens whenever a call finds the access token within
  5 minutes of expiry (`83`, `117-120`), so about every 55 minutes of active
  use.
- The code comment says Intuit rotates the refresh token "typically every
  ~24h" (`547-549`). That cadence is UNVERIFIED.

**When W1 happens.**

- `authenticate()` runs it when the refresh token or realm is missing
  (`602-603`).
- `refreshAccessToken()` runs it when there is no refresh token (`496-497`).
- In **sandbox**, it is also the fallback when the refresh token is rejected
  (`627-640`).
- `npm run auth` (`src/auth-server.ts:31`) reaches W1 only if `.env` lacks a
  token or realm. With both present it just refreshes, so it **cannot add or
  switch a company**.

**Caveats relevant to the brief:**

- **A failed persist is swallowed.** `556-560` (W2) logs and continues: the
  new token lives only in memory and the file keeps the old one. Whether
  Intuit invalidates the old token immediately is UNVERIFIED. The code assumes
  it does (`125-128`).
- **No `fsync`** happens before the rename. So the write is safe against a
  process crash, but durability after a power loss is not guaranteed.
- **Windows rename can fail.** `renameSync` over an existing file can fail on
  Windows when another process holds the target open (antivirus, indexer,
  sibling server). There is no retry, and the failure lands in the swallow
  path above.
- **`mode: 0o600` does not protect the file on Windows.** Node only maps the
  read-only bit there, so the file gets the directory's ACL.
- **No cross-process lock** around the read-modify-write. Two processes on the
  same file get last-writer-wins. This is partly mitigated by re-reading the
  file after an `invalid_grant` (`519-540`).
- **For the `.mcpb`:** the default path is inside the extension's install
  directory. Left as is, the first rotation would write a **plaintext refresh
  token into the install directory**, and an extension update would delete
  it. Both break acceptance tests.

## 2. Env-supplied `QUICKBOOKS_REFRESH_TOKEN` vs a different value in `.env`: which wins?

**`.env` wins.** `dotenv.config({ path: TOKEN_STORE_PATH, override: true })`
(`quickbooks-client.ts:41`) copies every key in the file over `process.env`
**before** the values are captured into module constants (`52-58`).

I confirmed this with a scratch script against the built `dist/` module. It
used `QUICKBOOKS_TOKEN_STORE_PATH` pointing at a scratch file and fake token
strings. No repo change was involved.

| Host env | `.env` file | Client starts with |
|----------|-------------|--------------------|
| `from-env` | `from-file` | `from-file` |
| `from-env` | `QUICKBOOKS_REFRESH_TOKEN=` (empty) | `""` (treated as no token, so it goes into the OAuth flow) |
| `from-env` | key absent | `from-env` |
| `from-env` | no file | `from-env` |

**After a rotation:**

1. W2 writes the new token to the **file only**. `process.env` is not updated,
   which doesn't matter because the client keeps the token in memory.
2. On the next start, the file's rotated value overrides the now-stale host
   value. That is the intended behaviour, and the scratch test confirmed it.
3. The env value is never consulted again, including by
   `readPersistedRefreshToken()` (`129-142`), which reads the file only.

**What this means for packaging:**

- If the file disappears (for example, an extension update replaces the
  install directory), the server silently falls back to the original
  env-supplied token. That token has probably been rotated out, so the next
  refresh fails.
- The override applies to **every key**, not just tokens. A stale `.env`
  silently overrides the host's `QUICKBOOKS_CLIENT_ID`, `_SECRET`,
  `_ENVIRONMENT` and the `QUICKBOOKS_DISABLE_*` toggles.
  - Confirmed: host `QUICKBOOKS_DISABLE_DELETE=true` with file `=false` gives
    `false`, which re-enables delete tools.
  - The new store must not reuse "dotenv override of everything".
- The comment at `37-40` says the override exists to beat empty placeholders
  from the host. As the table shows, the reverse also happens: an empty value
  in the file blanks a valid host value.

## 3. How are tools registered? Is there a single place to add a parameter or wrapper?

**Yes, there is a single choke point:** `RegisterTool()` in
`src/helpers/register-tool.ts:115-163`.

- **Definitions.** Each tool is a `ToolDefinition { name, description, schema,
  handler }` (`src/types/tool-definition.ts:4-9`), one per file in
  `src/tools/` (142 files).
- **Registration.** There are 142 explicit `RegisterTool(server, X)` calls in
  `src/index.ts:211-435`, plus 3 commented-out calls at `261`, `264` and
  `267`. `server.tool(...)` is called in exactly one place in `src/`:
  `register-tool.ts:162`.
- **What `RegisterTool` already does for every tool:**
  - **Gating by name prefix** (`119`, using `getCrudCategory` at `45-50` and
    `isToolDisabled` at `56-60`). A tool is disabled only when its env var is
    exactly `"true"` (`59`); `"TRUE"` or `"1"` will not disable it. How MCPB
    passes a boolean `user_config` value into env is UNVERIFIED. Check this in
    Phase 5.
  - **Wrapping the schema** as `{ params: <tool schema> }` (`162`). Every
    tool's arguments are nested under `params`, and tool handlers read only
    `args.params` (for example `src/tools/create-journal-entry.tool.ts:46`).
  - **Wrapping the handler** (`125-160`). It strips undeclared keys inside
    `params`, prepends a warning naming them, and passes the result through.
    This shows the wrapper can already rewrite arguments and annotate results.
- **Conclusion.** A `company` argument can be added **once**, in
  `RegisterTool`, as a top-level sibling of `params`, as in
  `{ company, params }`. That leaves:
  - all 142 tool schemas untouched;
  - the unsupported-parameter logic untouched, since it only inspects
    `params`.

  The same wrapper can prepend "Applied to: <company>" to every write result.

**Tool naming:**

| Prefix | Tools | Category |
|--------|-------|----------|
| `create` | 25 | WRITE |
| `update` | 26 | UPDATE |
| `delete` | 20 | DELETE |
| `get` | 40 | READ |
| `search` | 29 | READ |
| `read` | 2 (`read_invoice`, `read_item`) | READ |
| **Total** | **142** | |

- Eight tools use the legacy hyphen form: `create-bill`, `update-bill`,
  `delete-bill`, `get-bill`, and the same four for `vendor`. The prefix map
  handles both separators (`register-tool.ts:32-39`).
- No tool is renamed.

**Observation, not in scope:** none of the 142 tool files sets the MCP result
flag `isError: true`. Failures come back as ordinary content text such as
`"Error creating journal entry: ..."` (`create-journal-entry.tool.ts:48-54`).

## 4. How is the QuickBooks client constructed, and how hard is one client per realm?

**Construction:**

- **At import.** `quickbooks-client.ts` has import-time side effects:
  - resolves the token-store path (`28-35`);
  - loads `.env` with override (`41`);
  - installs process-wide `uncaughtException` and `unhandledRejection`
    handlers that log and swallow (`45-50`);
  - reads env into constants (`52-58`);
  - throws if the client ID or secret is missing (`61-63`);
  - builds the **module-level singleton** `quickbooksClient` (`706-713`).
- **Per request.** Handlers call the static
  `QuickbooksClient.getInstance()` (`670-678`). It runs `authenticate()` when
  the access token is stale, and `authenticate()` builds a **fresh
  `node-quickbooks` instance** on each refresh (`644-656`).
- **Call sites.**
  - All 142 handlers call `QuickbooksClient.getInstance()` exactly once, with
    no arguments.
  - One handler also calls `QuickbooksClient.getAuthCredentials()`
    (`src/handlers/create-quickbooks-attachable.handler.ts:323`) for a raw
    HTTPS upload.
  - Nothing outside `src/clients/` touches the singleton except
    `src/auth-server.ts:31`.

**What is already per-instance** (good for multi-company):

- `QuickbooksClient` takes its whole config in the constructor (`95-115`), and
  tests already build instances directly
  (`tests/unit/clients/quickbooks-client.resilience.test.ts:113`).
- Access token, expiry, in-flight refresh/auth promises and the
  `node-quickbooks` instance are all instance fields (`70-93`).
- `node-quickbooks` keeps `realmId`, token and endpoint per instance
  (`node_modules/node-quickbooks/index.js:94-112`).
  `get-quickbooks-company-info.handler.ts:8` reads the realm from the
  instance.
- Nothing in `src/` calls node-quickbooks' own `refreshAccessToken()`
  (`index.js:121-138`), which rotates the token without persisting it.

**What is global and must change:**

1. **Persistence is not per-instance (the main blocker).**
   `saveTokensToEnv()` and `readPersistedRefreshToken()` use the
   module-level `TOKEN_STORE_PATH` and the fixed key names
   `QUICKBOOKS_REFRESH_TOKEN` / `QUICKBOOKS_REALM_ID` (`136-137`,
   `425-439`). Two instances would overwrite each other's token.
   Persistence needs to be injectable per realm.
2. **The static accessors are hard-wired to the singleton.**
   `getInstance()` and `getAuthCredentials()` (`670-696`) need a way to
   choose the realm.
3. **The interactive OAuth flow is per-instance but uses a fixed port.**
   - It always listens on port 8000 (`263`) and has only a per-instance
     `isAuthenticating` guard (`258-262`). Two instances would collide.
   - It is also the **automatic fallback inside `authenticate()`** (`602-609`,
     `633-640`). With several companies, a dead token for company B should
     return "reconnect company B", not open a browser in the middle of an
     unrelated tool call.
4. **Import-time side effects.** The class can't be imported without loading
   `.env` and building the singleton. This is harmless if the singleton stays
   unused, but it is still the env-precedence trap from §2.

**Effort.**

- The client changes stay in `quickbooks-client.ts` and are small:
  - an optional token-store hook in the constructor, defaulting to today's
    `.env` behaviour so upstream tests keep passing;
  - an overridable resolver behind the two static methods.
- Holding one `QuickbooksClient` per realm in a new registry module is
  straightforward.
- The open question is how the **per-call company gets from the tool argument
  to `getInstance()`**. These are the options:

| Option | How | Upstream edits | Test churn | Notes |
|--------|-----|----------------|------------|-------|
| **A. Call-scoped context** (recommended) | `RegisterTool` adds a required `company` argument and runs the handler inside `AsyncLocalStorage.run(company, ...)`. `getInstance()` and `getAuthCredentials()` read the context and **throw if none is set** (fail closed). | `register-tool.ts` wrapper, plus the two static methods | None for the 28 test files that mock the client module (`getInstance()` signature unchanged) | The argument is still explicit on every call. The context lives only for that one call, so there is no "currently selected company" state. `getInstance()` is awaited at the top of each handler, so the context is always present. |
| B. Thread it explicitly | Add `company` to each tool and pass it into each handler and into `getInstance(company)` | ~142 tool files and ~142 handler files | All 28 mocking test files plus the tool tests | Most explicit, but the largest diff and the hardest fork to rebase. Every new upstream tool needs the same edit. |
| C. A now, B for writes later | As A, then move only the ~71 create/update/delete handlers to explicit passing | A, plus ~71 tool/handler pairs later | Moderate | Only worth it if a reviewer wants the write path explicit at the type level. |

Because Option A makes this cheap, I don't think the brief's "expensive across
all tools" condition applies. It is still a design choice, so it's listed
below for a decision before Phase 3.

## 5. Test suite baseline

- **Environment:** Linux, Node v22.22.0, npm 10.9.4. CI also runs
  `windows-latest` (`.github/workflows/ci.yml:16`); Windows was **not** run
  here.
- **`npm ci`:** succeeded. Its `prepare` script runs `npm run build` (`tsc`),
  which also succeeded.
- **`npm test`:** **35 of 35 suites passed; 639 of 639 tests passed**, in
  13.7 s, exit code 0. Coverage gates were met:

  | Scope | Statements | Branches | Functions | Lines |
  |-------|-----------|----------|-----------|-------|
  | All files | 97.38 | 94.99 | 98.56 | 97.15 |
  | `quickbooks-client.ts` | 80.08 | 65.38 | 76.92 | 80.34 |

  The per-file floors for `quickbooks-client.ts` are 70/45/70/70
  (`jest.config.js`). Everything else is gated at 100%, apart from two account
  handlers with documented floors.
- **`npm run lint`:** clean.
- The test output includes expected `console.error`/`console.log` noise from
  the client and attachable tests. These are deliberately exercised paths, not
  failures.

---

## Other findings that affect later phases

- **The interactive OAuth flow writes to stdout.** It calls `console.log` at
  `quickbooks-client.ts:295`, `311`, `394` and `402-405`. In the stdio server,
  stdout is the MCP channel. So the sandbox fallback (`633-640`) would inject
  non-protocol text into the JSON-RPC stream. The test output confirms these
  lines run on that path.
- **The callback URL is logged.** Line `295` logs the full callback URL,
  including the one-time authorization `code` and the `realmId`. This breaks
  the brief's "never log tokens; logs go to stderr" rule. Phase 4 must not
  reuse `startOAuthFlow()` as is.
- **The OAuth wait has no timeout** (`277-421`). If the user never finishes in
  the browser:
  - the promise never settles, so `authInFlight` is never cleared
    (`595-664`);
  - port 8000 stays bound;
  - every later tool call waits on the same hung promise.
- **Process-wide error handlers.** `quickbooks-client.ts:45-50` installs
  `uncaughtException` and `unhandledRejection` handlers that only log. Any
  uncaught error anywhere in the server is swallowed, and the process keeps
  running.
- **Lazy refresh only.** A company that isn't used is never refreshed. For an
  accountant with several clients, a rarely used company could reach the
  refresh-token lifetime without being touched. Whether a refresh resets the
  100-day window is UNVERIFIED. Consider a refresh-on-start, or a warning in
  the company list, in Phase 2 or 3.
- **Licence metadata is inconsistent three ways.** `LICENSE` is Apache-2.0,
  the README badge says MIT (`README.md:7`), and `package.json` has
  `"license": "MIT"`. The `.mcpb` manifest will need one answer. Keep
  `LICENSE` as is, per the brief.

## Decisions and inputs needed before later phases

1. **Pending inputs from the brief (still open):**
   - how many client companies need to be connected;
   - which write actions are needed;
   - whether update and delete are ever needed.
2. **Multi-company plumbing (Phase 3):** Option A, B or C from §4.
   Recommendation: **A**.
3. **`company` on reads:** should it be required on read tools too, or only
   on writes? Recommendation: required on every tool. The acceptance test
   "runs a report against each and returns the right company's data" has the
   same wrong-company risk as writes.
