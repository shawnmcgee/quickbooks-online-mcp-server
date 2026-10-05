# Project brief: QuickBooks Online extension for Claude Desktop

Read this before doing anything in this repo. Items marked UNVERIFIED are
assumptions to check against the source or current docs, not facts.

## Goal

Package a fork of Intuit's QuickBooks Online MCP server as a Claude Desktop
extension (.mcpb) that a non-technical accountant can install and use without
a terminal, Git, Node, or hand-edited JSON.

- Upstream: https://github.com/intuit/quickbooks-online-mcp-server (TypeScript, stdio)
- End user: one accountant, on Windows, using Claude Desktop. Single user.
- He works across multiple client companies in QuickBooks Online.
- The developer (repo owner) has no QuickBooks domain knowledge. The end user
  is the judge of accounting correctness; we are responsible for the plumbing.

## Pending inputs (ask the developer, do not guess)

- How many client companies he needs connected.
- Which write actions he actually needs (e.g. journal entries, bills), and
  whether he ever needs update or delete.

## What success looks like for the end user

1. Double-click one .mcpb file, or drag it into Claude Desktop.
2. Paste Client ID and Client Secret into the settings form.
3. Say "connect a client", sign in to QuickBooks in the browser, approve.
4. Ask questions and request entries by client name. It keeps working after
   restarts, token rotations, and extension updates.

## Known facts about upstream (from its README)

- Config via env: QUICKBOOKS_CLIENT_ID, QUICKBOOKS_CLIENT_SECRET,
  QUICKBOOKS_REFRESH_TOKEN, QUICKBOOKS_REALM_ID, QUICKBOOKS_ENVIRONMENT
  (sandbox | production).
- QUICKBOOKS_DISABLE_WRITE / _UPDATE / _DELETE = "true" stops create_* /
  update_* / delete_* tools from being registered. get_* and search_* are
  always registered. Categorisation is by tool-name prefix, so any new tool
  must follow the {verb}_{entity} convention.
- `npm run auth` runs the OAuth handshake in a browser and saves tokens to .env.
- Sandbox accepts http://localhost:8000/callback. Production rejects localhost
  and needs a public HTTPS redirect URI for the initial authorization.
- Refresh tokens auto-rotate; the server persists the new one on each refresh.
  The refresh window lapses after 100 days.
- .env is resolved relative to the compiled module, not the working directory.
- One server process is tied to one company (one realm ID).

## Phase 0: Recon (do this first, write findings to docs/RECON.md)

Answer by reading the source, with file and line references:

1. Where exactly is the rotated refresh token written, and when?
2. If QUICKBOOKS_REFRESH_TOKEN is supplied by the process environment AND a
   different value is in .env, which one wins? What happens after a rotation?
3. How are tools registered? Is there a single place to add a parameter or
   wrapper to all of them, or is it per-handler?
4. How is the QuickBooks client constructed, and how hard is it to hold one
   client per realm instead of a single global one?
5. Run the existing test suite and record the baseline result.

Do not change code in this phase.

## Design

### Token and company store

- Keep a registry of connected companies: display name, realm ID,
  environment, refresh token.
- Store it outside the extension's install directory (e.g. under %APPDATA%)
  so extension updates do not wipe it.
- Refresh tokens are secrets. Propose the best option available on Windows
  (OS credential storage preferred over a plain file) and explain the trade-off
  before implementing.
- Rotated tokens must be written back to this store atomically. A crash
  mid-write must not lose the only valid token.

### Multi-company

The worst failure mode for this user is posting an entry to the wrong
client's books. Design against that:

- Prefer an explicit company argument on every write call over a hidden
  "currently selected company" state.
- Every write result should state which company it was applied to.
- Add a tool to list connected companies.
- If Phase 0 shows this is expensive across all tools, propose options and
  wait for a decision rather than picking one.

### Connect-a-company flow

- A tool the user can trigger in conversation that opens the browser, runs the
  OAuth handshake, and saves the new company to the store.
- Sandbox: use the localhost callback.
- Production: needs a public HTTPS callback. Candidate approach (UNVERIFIED):
  a static HTTPS page that forwards the code, realmId and state to the local
  listener. Fallbacks: a tunnel, or manual paste from Intuit's OAuth
  Playground. Solve sandbox end to end before touching this.

### Packaging (.mcpb)

- Follow the current MCPB docs and spec; check them rather than relying on
  memory: https://claude.com/docs/connectors/building/mcpb and
  https://github.com/modelcontextprotocol/mcpb
- manifest.json `user_config` fields: Client ID, Client Secret (sensitive),
  environment, and toggles for write / update / delete.
- Defaults: sandbox, delete off. Decide write and update defaults once the
  pending inputs above are answered.
- The bundle must be self-contained and must not include .env, tokens, or
  any credentials.

## Rules for working in this repo

- Sandbox only. Never request, store, or use production credentials or real
  client data during development.
- Never print or log tokens or the client secret. Logs go to stderr; stdout
  is the MCP stdio channel.
- Keep the fork easy to rebase: put new code in new modules and keep edits to
  upstream files small. Keep the upstream LICENSE file (the repo is listed as
  Apache-2.0 although the README badge says MIT).
- Do not rename existing tools.
- Run the test suite before and after each phase. Add tests for the token
  store and company selection.
- Target Windows first: paths, opening the browser, file permissions.

## Phases

0. Recon (above).
1. Stock server working against a sandbox company, unchanged.
2. Token and company store, with rotation persistence.
3. Multi-company selection and the list tool.
4. Connect-a-company tool (sandbox).
5. .mcpb packaging and a clean-machine install test.
6. Production authorization flow.
7. End-user setup guide in plain English, with screenshots placeholders.

Stop and report at the end of each phase.

## Acceptance tests

On a Windows machine with only Claude Desktop installed:

- Installs from the .mcpb with no other software.
- Settings form accepts credentials; nothing sensitive is written in plain
  text inside the install directory.
- Connects two sandbox companies through the browser flow.
- Runs a report against each and returns the right company's data.
- Creates a journal entry in a named company, and the result names it.
- Still works after restarting Claude Desktop.
- Still works after a forced token rotation.
- Still has its connected companies after reinstalling a newer .mcpb.
- With delete disabled, no delete_* tools are present.

## Out of scope

- A hosted or remote server; multiple users; QuickBooks Desktop.
- Judging whether an accounting entry is correct.
- Intuit's production-key application (reported to need an app questionnaire
  plus privacy policy and EULA URLs; UNVERIFIED). The end user completes that
  under his own Intuit login.
