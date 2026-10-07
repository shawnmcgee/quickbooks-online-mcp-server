# Decisions log

Inputs and decisions that later phases rely on. `PROJECT_BRIEF.md` still has
the original brief.

## Inputs from the end user (received 2026-10-07)

- **Clients:** about 22 client companies, but not all of them need connecting.
- **Writes he'd like.** None is a hard must-have:
  - invoice creation;
  - checks;
  - bills;
  - expenses;
  - journal entries;
  - categorizing bank-feed transactions.
- **Update and delete:** not requested.

## Decisions

| Topic | Decision | Made after |
|-------|----------|------------|
| Multi-company plumbing | Option A: a call-scoped context set by the `RegisterTool` wrapper; `getInstance()` fails closed without it | Phase 0 |
| `company` argument | Required on **every** tool, reads included | Phase 0 |
| Company matching | Exact match against the registry. On a miss, return the list of connected companies. No fuzzy matching. | Phase 0 |
| "Applied to" text | Derived from the client instance used for the call | Phase 0 |
| Store contents | Tokens and the company registry only. No dotenv override. | Phase 0 |
| Rotated refresh tokens | Treat the old token as invalid immediately. Retry failed saves on Windows; surface a persistent failure in the tool result. | Phase 0 |
| Refresh | Refresh every connected company on start, plus a reconnect path | Phase 0 |
| OAuth for connect/reconnect | Do not reuse `startOAuthFlow()`. Phase 4 gets its own flow: with a timeout, no logging of the callback URL, bound to `127.0.0.1` (finding from Phase 1). | Phase 0 |
| Token backend | Windows Credential Manager via `@napi-rs/keyring`; no plaintext fallback | Phase 2 proposal |
| Create tools exposed | **Requested actions only**: `create_invoice`, `create-bill`, `create_journal_entry`, plus the new `create_check` and `create_expense`. The other 22 create tools stay off, including the raw `create_purchase`, so missing customers, vendors and items are created in QuickBooks by the user. | Inputs above |
| Checks and expenses | Add `create_check` and `create_expense`: explicit fields, built on the existing purchase handler, no renames | Inputs above |
| Update and delete | Off by default. Settings toggles exist to turn them on. | Inputs above |
| Bank-feed categorizing | Investigate first. Findings below; decision pending. | Inputs above |

**Planned for Phase 3, not yet confirmed:**
- Cap the startup refresh at about 4 companies at a time, run in the
  background. Intuit's token-endpoint rate limits are UNVERIFIED.

## Bank-feed categorizing: findings

**1. The public API can't do it.** The QuickBooks Online Accounting API
doesn't expose the "For Review" bank-feed items, so nothing can read or
categorize them. Intuit's developer forum confirms this ([1], [2]).
Transactions created through the API post directly to the books, not into
For Review ([3]).

**2. The closest workaround is "record via Claude, then Match in QuickBooks."**
Intuit's help says the bank feed matches a downloaded line to a transaction
"you already entered", whatever was used to enter it ([4]). Conditions:

- same bank or card account;
- same amount;
- dated from 90 days before to 20 days after the bank line ([5]);
- not reconciled;
- not already matched;
- a compatible type: a check matches a check; an expense matches a debit, ACH
  or card line ([4]).

**3. Risks.**
- **Bank rules:** a rule that auto-adds bank lines creates a new expense before
  matching can happen, which leads to duplicates ([6]).
- **Posting order:** one expense-management vendor reports QuickBooks failing
  to match when the API entry is posted **before** the bank line downloads
  ([6]). That contradicts Intuit's description and couldn't be checked
  first-hand: the page is blocked from this environment, and only a search
  summary was read.

**4. Status.** It is UNVERIFIED that API-created checks and expenses get
matched. Run the sandbox test below before deciding. Whatever the result,
Claude can't click Match. He still reviews each bank line in QuickBooks.

### Proposed sandbox test

Run this after Phase 3, once `create_check` and `create_expense` exist. It
can also run sooner with the stock `create_purchase`.

1. **Create the entries through the server.**
   - A check from the sandbox Checking account for an odd amount (e.g. 123.45),
     dated today.
   - An expense for a different amount.
2. **Upload a matching bank file.** In the sandbox company, go to Banking →
   Upload transactions. Upload a small CSV for Checking with lines for the same
   amounts and dates. Whether file upload works in a sandbox company is
   UNVERIFIED.
3. **Check For Review.** Each line should show a suggested **Match** to the
   entry from step 1, not "Add".
4. **Repeat in the other order.** Upload the bank line first, then create the
   entry, to check the posting-order risk.

**If both orders match:** offer "record it, then Match" as the bank-feed
workflow. **If not:** bank-feed categorizing stays a manual step in QuickBooks.

### Sources

1. [Pull "For Review" transactions through QBO API (Intuit developer help)](https://help.developer.intuit.com/s/question/0D54R00007y2pv0SAA/pull-for-review-transactions-through-qbo-api)
2. [Fetch bank feed pending transactions in my app? (Intuit developer help)](https://help.developer.intuit.com/s/question/0D5TR00001JtbjS0AR/i-want-to-fetch-bank-feed-pending-trasnactions-in-my-app-is-it-possible)
3. [QBO API purchase/deposit doesn't go to the review section (QuickBooks community)](https://quickbooks.intuit.com/learn-support/en-us/payments/quickbook-online-api-purchase-deposit-creditcardpayment-does-not/00/1170902)
4. [Match your bank and credit card transactions (QuickBooks help)](https://quickbooks.intuit.com/learn-support/en-us/help-article/bank-feeds/match-online-bank-transactions-quickbooks-online/L6qyw0PvP_US_en_US)
5. [AI suggestions to help match and categorise bank transactions (QuickBooks help)](https://quickbooks.intuit.com/learn-support/en-global/help-article/bank-transactions/ai-suggestions-help-match-categorise-bank/L8FHOh4AD_ROW_en)
6. [How to avoid duplicate transactions in QuickBooks Online (Capital One expense management help)](https://help-manageexpenses.capitalone.com/en/articles/10411939-how-to-avoid-duplicate-transactions-in-quickbooks-online)
