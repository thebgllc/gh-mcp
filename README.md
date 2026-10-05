# gh-mcp

A small, self-hosted [MCP](https://modelcontextprotocol.io) server that gives
Claude (or any MCP client) read/write access to GitHub, deployed as a
Cloudflare Worker and backed by a GitHub Personal Access Token you control.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/thebgllc/gh-mcp)

The button forks the repo and deploys it. You still need to set the two
secrets afterwards (step 3 of [Setup](#setup)) before it will answer.

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

There is no OAuth here. The secret lives in the URL path itself:

```
https://<your-worker>.<your-subdomain>.workers.dev/mcp/<MCP_TOKEN>
```

That keeps setup to a single pasted URL, but it means:

- **Anyone with that exact URL can use your GitHub token**, with every
  permission the token has. Treat the URL like a password: don't paste it
  anywhere public, don't commit it, don't share screenshots of it.
- **Scope the token tightly.** A fine-grained PAT limited to specific repos
  and only the permissions you need caps the damage if the URL leaks.
- **Use a long random `MCP_TOKEN`**, e.g. `openssl rand -hex 24`. Wrong
  tokens get a plain 404, and the comparison is constant-time.
- If you think the URL has leaked, rotate it (see
  [Rotating the token](#rotating-the-token)). If you think the PAT itself
  leaked, revoke it on GitHub as well.

## Setup

1. **Create a GitHub PAT.**
   Go to https://github.com/settings/tokens?type=beta (fine-grained) or the
   classic token page. Grant it `repo` scope (classic) or Contents +
   Issues + Pull requests read/write (fine-grained). Contents write also
   covers `delete_file`.

   **Prefer a fine-grained token limited to the repositories you actually
   want Claude to touch.** Whoever holds the connector URL can do anything
   the token can (see [Security](#security)), so keep its reach small.

   For the Actions/cost tools, add:
   - classic: `repo` already covers reading runs and jobs on private repos;
     `user` covers your own billing, `read:org` + `manage_billing:organization`
     an org's.
   - fine-grained: Actions **read**, plus account permission Plan **read**
     (user billing) or the organization's billing read (org billing).

   For the Projects tools, add `project` (classic) or account permission
   Projects **read and write** (fine-grained).

   `get_actions_billing` reports which endpoint it used and what GitHub said
   when both are refused, so a missing scope shows up as a named error rather
   than an empty result.

2. **Install deps and log in to Cloudflare** (from this project directory):
   ```
   npm install
   npx wrangler login
   ```

3. **Set secrets:**
   ```
   npx wrangler secret put GITHUB_TOKEN
   # paste your PAT when prompted

   npx wrangler secret put MCP_TOKEN
   # paste a long random string, e.g. output of: openssl rand -hex 24
   ```

4. **Deploy:**
   ```
   npx wrangler deploy
   ```
   This prints your Worker URL, e.g. `https://gh-mcp.<subdomain>.workers.dev`.

5. **Add to Claude:**
   Settings → Connectors → Add custom connector →
   `https://gh-mcp.<subdomain>.workers.dev/mcp/<your MCP_TOKEN>`
   No OAuth Client ID/Secret needed — leave Advanced settings blank.

6. **Enable it in a conversation** via the "+" → Connectors toggle, and try
   asking Claude to read a file from one of your private repos.

## Local testing

```
npx wrangler dev
```
Then POST JSON-RPC to `http://localhost:8787/mcp/<MCP_TOKEN>`, e.g.:

```bash
curl -s http://localhost:8787/mcp/<MCP_TOKEN> \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_repo","arguments":{"owner":"octocat","repo":"Hello-World"}}}' | jq
```

## Contributing

Issues and PRs are welcome. To report a security problem, please use
GitHub's private vulnerability reporting (Security tab → *Report a
vulnerability*) rather than a public issue.

## Extending it

Tools live in `src/index.js` — each is a case in `callTool()` plus an entry
in the `TOOLS` array (JSON Schema for its arguments). To add e.g.
`list_prs` or `get_pr_diff`, copy the shape of an existing tool and hit the
matching GitHub REST endpoint via the `gh()` helper.

## Rotating the token

If the URL ever leaks: `npx wrangler secret put MCP_TOKEN` with a new value,
redeploy, and update the connector URL in Claude's settings.

## License

[MIT](LICENSE)
