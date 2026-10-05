# gh-mcp

A small, self-hosted [MCP](https://modelcontextprotocol.io) server that gives
Claude (or any MCP client) read/write access to GitHub, deployed as a
Cloudflare Worker and backed by a GitHub Personal Access Token you control.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/thebgllc/gh-mcp)

The button forks the repo and deploys it. You still need to set its secrets
afterwards (steps 3–4 of [Setup](#setup)) before it will answer.

**Why use this:** Claude's built-in GitHub connector goes through an OAuth →
GitHub App handoff that can fail on private repos and limits what you can
reach. This server calls the GitHub API directly with your own token, so it
sees exactly what your token sees: private repos, Actions billing,
Projects (v2) and more.

**This is not a shared service.** Everyone deploys their own copy to their own
Cloudflare account (the free plan is plenty) with their own token. Nothing is
sent anywhere except GitHub's API.

## What it does

Exposes 28 tools over MCP:

- **Files:** `get_file`, `push_file`, `delete_file`
- **Repos:** `get_repo`, `list_repos`, `create_repo`, `create_branch`, `list_branches`
- **Issues:** `list_issues`, `get_issue`, `create_issue`, `update_issue`, `add_issue_comment`
- **PRs:** `list_prs`, `get_pr`, `create_pr`, `merge_pr`
- **History/search:** `list_commits`, `get_commit`, `search_code`, `search_issues`
- **Actions/cost:** `list_workflows`, `list_workflow_runs`, `get_actions_billing`
- **Projects:** `get_project`, `list_project_items`, `add_project_item`, `update_project_item_field`

All calls go straight to the GitHub REST API using a Personal Access Token you
control — no OAuth handoff, no GitHub App installation, no Anthropic-side scope
translation to go wrong. `get_issue` and `get_pr` fall back to GraphQL when the
REST endpoint 5xxs.

`delete_file` looks the blob SHA up from the branch itself, so removing a file
is a single call — no `get_file` round trip, and no need to gut a file with a
stub because deletion isn't available.

## Writing to a branch

`push_file` needs no blob SHA from you. It resolves one from the branch it is
committing to, so `owner/repo/path/content/message/branch` is always enough,
whether the file is new or being overwritten, on the default branch or any
other. It reports the new blob SHA back, so a run of edits to the same file
never needs a read in between. Pass `sha` explicitly only when you want the
optimistic-concurrency guard: the write then fails rather than retrying if the
file moved under you.

This matters more than it looks, because GitHub's contents API is edge-cached
per URL and caches misses as well as hits. Checking whether a file exists on a
branch pins that 404 for about a minute, so the read that would have told you
the SHA to overwrite with keeps answering "not found" — most visibly on a branch
you just created, where every path misses once. Reads here carry a nonce so they
are never served a cached answer, and a 404 is cross-checked against the parent
directory listing before it is believed: the per-path endpoint trails the
directory index by a beat after a commit, and the listing entry carries the blob
SHA anyway.

`get_file` reads any branch, tag, or commit via `ref` (or `branch`, same thing),
and echoes a `REF:` line so it is unambiguous which branch the SHA belongs to.
A 404 now says which half went wrong — bad ref, or good ref and bad path — and
lists the branches or the sibling files accordingly. `list_branches` gives you
exact branch names when a ref is rejected.

## Binary files

`get_file` and `push_file` handle binary (images, PDFs, archives, fonts) as
well as text:

- **Reading** — `get_file` decodes as UTF-8 and, if the bytes aren't valid
  UTF-8, returns base64 under an `ENCODING: base64` header instead. PNG/JPEG/
  GIF/WebP are additionally returned as an inline image block, so Claude can
  actually see them. Force either behaviour with `encoding: "text" | "base64"`.
- **Writing** — pass `content_encoding: "base64"` to `push_file` and the
  content is committed byte-for-byte, not re-encoded. Round-tripping a file is
  therefore `get_file` → paste its base64 → `push_file`.
- **Size** — files above the inline ceiling (1 MB text, 256 KB binary; override
  with `max_bytes`) return metadata plus a short-lived pre-authorized download
  URL rather than content, since base64 inflates by a third and it all lands in
  the model's context. Files between 1 MB and 100 MB are read via the Git blobs
  API, which the contents API can't serve.

## Actions cost data

`list_workflow_runs` answers "what is CI actually costing us" with numbers
rather than inference from the workflow YAML:

```
list_workflow_runs {owner, repo, created: ">=2026-07-01", per_page: 25,
                    include_timing: true}
```

It returns each run's status, trigger, branch and wall-clock duration, and with
`include_timing` also per-run billable minutes plus a **by workflow** rollup —
which is the line that tells you where the minutes go.

Two things worth knowing about how those minutes are derived:

- **The `/timing` endpoints are not used.** On accounts migrated to GitHub's
  enhanced billing platform they still return 200 but report `total_ms: 0` for
  every job, which reads as "this run was free" when it wasn't. Minutes are
  instead summed from each job's start/finish timestamps, rounded up to a whole
  minute per job — which is how GitHub bills.
- **They're raw minutes.** Against your included allowance macOS counts 10x and
  Windows 2x; the output reports per-OS totals so you can apply that yourself.

Timing costs one extra API call per run, so it stops after 25 runs (a Worker
request has a subrequest budget) and says so when it truncates.

`get_actions_billing` covers the account-level view. On the enhanced billing
platform it returns the per-repository and per-SKU breakdown for the billing
period; otherwise it falls back to the legacy summary (used / included / paid
minutes with a per-OS split). It defaults to the authenticated user — pass
`account` plus `account_type: "org"` for an organization, and note that a
personal account is *not* an org, so for your own user leave `account` unset.

## Projects

The Projects tools cover GitHub's current Projects (v2), which exist only in
GraphQL, and work the same for a user-owned project as an org-owned one:

```
get_project                {owner: "octocat", number: 1}
list_project_items         {owner: "octocat", number: 1}
add_project_item           {owner: "octocat", number: 1, content_repo: "my-repo", content_number: 12}
add_project_item           {owner: "octocat", number: 1, draft_title: "Write the docs"}
update_project_item_field  {owner: "octocat", number: 1, item_id: "PVTI_...",
                            fields: {"Stage": "Public alpha", "Approvals": 5,
                                     "Last contact": "2026-09-28", "Next step": null}}
```

Fields are addressed by name, never by id: single-select values match option
names case-insensitively, dates are `YYYY-MM-DD`, and `null` clears a field.
Every name and value is checked against the project before anything is written,
so a typo fails the call instead of half-applying it, and the error lists the
valid fields or options. `add_project_item` takes the same `fields`, and adding
an issue that is already on the project returns its existing item.

Needs the `project` scope on the token (`read:project` for the two read tools).
Without it, the error names the missing scope.

## Security

Whoever can call this server can use your GitHub token. There are two ways to
control who that is, and you can turn on either or both:

- **Sign in with GitHub (OAuth) — recommended.** The connector URL is just
  `https://<your-worker>/mcp`, which is safe to share. When an MCP client
  connects, you approve it on a consent page and sign in with GitHub, and only
  GitHub accounts on your `ALLOWED_GITHUB_USERS` list get through. The client
  then holds a short-lived token it refreshes itself. Removing someone from
  the list cuts them off on their next call.
- **Secret URL token.** The connector URL is
  `https://<your-worker>/mcp/<MCP_TOKEN>`, and the token in the path *is* the
  credential. Simpler to set up (no GitHub OAuth app), but **anyone who gets
  the URL can use your GitHub token**: treat it like a password, and never
  paste it anywhere public or in a screenshot.

Whichever you use:

- **Use a fine-grained PAT, not a classic one.** A fine-grained token can be
  limited to specific repositories and to read-only access, and GitHub
  enforces that no matter who calls. A classic `repo` token reaches *every*
  repo you can access. If you only want Claude to read code, give the token
  read-only permissions and the write tools will simply be refused.
- **One owner per fine-grained token.** A fine-grained PAT covers either your
  account or one organization. If you need both, deploy this twice (different
  Worker `name` in `wrangler.toml`), one connector per owner, rather than
  falling back to a classic token.
- **Requests are rate limited** to 120 per minute per IP, before any
  credential is checked, which throttles guessing and bulk use of a leaked
  credential. Tune or remove the `[[ratelimits]]` block in `wrangler.toml`.

For the URL token specifically:

- **Use a long random `MCP_TOKEN`**, e.g. `openssl rand -hex 24`. The server
  refuses to serve it (503) if it is shorter than 32 characters. Wrong tokens
  get a plain 404, and the comparison is constant-time.
- **Keep request logging off.** If you turn on Workers Logs / observability,
  or run `wrangler tail`, the full request URL — token included — can be
  recorded, and anyone with access to your Cloudflare account can read it.
- If you think the URL has leaked, rotate it (see
  [Rotating credentials](#rotating-credentials)). If you think the PAT itself
  leaked, revoke it on GitHub as well.

## Setup

1. **Create a GitHub PAT** — the token the tools call GitHub with.
   Go to https://github.com/settings/personal-access-tokens/new
   (fine-grained). **Limit it to the repositories you actually want Claude to
   touch**, and grant Contents + Issues + Pull requests, read/write (or
   read-only if that's all you need). Contents write also covers
   `delete_file`.

   For the Actions/cost tools, add Actions **read**, plus account permission
   Plan **read** (user billing) or the organization's billing read (org
   billing). For the Projects tools, add account permission Projects **read
   and write**.

   If you must use a classic token instead: `repo`, plus `user` (or
   `read:org` + `manage_billing:organization`) for billing and `project` for
   Projects.

   `get_actions_billing` reports which endpoint it used and what GitHub said
   when both are refused, so a missing scope shows up as a named error rather
   than an empty result.

2. **Install deps, log in to Cloudflare, and deploy** (from this project
   directory):
   ```
   npm install
   npx wrangler login
   npx wrangler deploy
   ```
   This prints your Worker URL, e.g. `https://gh-mcp.<subdomain>.workers.dev`,
   and creates the KV namespace OAuth uses. The server won't answer MCP calls
   until the next steps are done.

3. **Set the GitHub token:**
   ```
   npx wrangler secret put GITHUB_TOKEN
   # paste your PAT when prompted
   ```

4. **Choose how clients get in** (one or both):

   **a. Sign in with GitHub (recommended).** Create a GitHub OAuth app at
   https://github.com/settings/applications/new with:
   - Homepage URL: your Worker URL
   - Authorization callback URL: `https://gh-mcp.<subdomain>.workers.dev/callback`

   Generate a client secret on the app's page, then:
   ```
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put ALLOWED_GITHUB_USERS
   # your GitHub login, or several separated by commas: alice,bob
   ```
   OAuth only switches on once all three are set; with no allowlist, nobody
   can sign in. The OAuth app only identifies who is signing in — it asks
   GitHub for no permissions, and API calls still use your PAT.

   **b. Secret URL token.**
   ```
   npx wrangler secret put MCP_TOKEN
   # paste a long random string, e.g. output of: openssl rand -hex 24
   ```

   Secrets take effect immediately; no redeploy needed.

5. **Add to Claude:** Settings → Connectors → Add custom connector, with the URL
   - OAuth: `https://gh-mcp.<subdomain>.workers.dev/mcp`
   - URL token: `https://gh-mcp.<subdomain>.workers.dev/mcp/<your MCP_TOKEN>`

   Leave the OAuth Client ID/Secret under Advanced settings blank either way:
   Claude registers itself with the server. With OAuth, Claude then opens
   the consent page; choose **Continue with GitHub** and sign in.

6. **Enable it in a conversation** via the "+" → Connectors toggle, and try
   asking Claude to read a file from one of your private repos.

## Local testing

Put test values in `.dev.vars` (gitignored), e.g. `GITHUB_TOKEN=...` and
`MCP_TOKEN=...` on separate lines, then:

```
npx wrangler dev
```
and POST JSON-RPC to `http://localhost:8787/mcp/<MCP_TOKEN>`:

```bash
curl -s http://localhost:8787/mcp/<MCP_TOKEN> \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_repo","arguments":{"owner":"octocat","repo":"Hello-World"}}}' | jq
```

To try the OAuth flow locally, create a second GitHub OAuth app whose callback
is `http://localhost:8787/callback`, put its ID and secret plus
`ALLOWED_GITHUB_USERS` in `.dev.vars`, and point an MCP client (e.g. the MCP
Inspector, `npx @modelcontextprotocol/inspector`) at
`http://localhost:8787/mcp`.

## Contributing

Issues and PRs are welcome. To report a security problem, please use
GitHub's private vulnerability reporting (Security tab → *Report a
vulnerability*) rather than a public issue.

## Extending it

Tools live in `src/index.js` (sign-in is in `src/oauth.js`) — each is a case in `callTool()` plus an entry
in the `TOOLS` array (JSON Schema for its arguments). To add e.g.
`list_prs` or `get_pr_diff`, copy the shape of an existing tool and hit the
matching GitHub REST endpoint via the `gh()` helper.

## Rotating credentials

- **URL token leaked:** `npx wrangler secret put MCP_TOKEN` with a new value
  and update the connector URL in Claude's settings. The old URL stops working
  at once. To drop the URL-token path entirely, `npx wrangler secret delete
  MCP_TOKEN`.
- **Someone shouldn't have OAuth access any more:** remove them from
  `ALLOWED_GITHUB_USERS`. Their next call is refused.
- **PAT leaked:** revoke it on GitHub, create a new one, and
  `npx wrangler secret put GITHUB_TOKEN`.

## License

[MIT](LICENSE)
