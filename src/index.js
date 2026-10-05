/**
 * gh-mcp — a minimal self-hosted MCP server for GitHub, backed directly by a
 * Personal Access Token instead of Anthropic's OAuth->GitHub App handoff.
 *
 * Auth model: the URL itself contains a secret path segment
 * (`/mcp/<MCP_TOKEN>`). Only someone who knows the full URL can call it.
 * This avoids needing OAuth or Claude's (currently beta/gated) custom
 * header auth. Treat the URL like a password — don't post it publicly.
 *
 * Deploy:
 *   wrangler secret put GITHUB_TOKEN   # PAT with "repo" scope
 *   wrangler secret put MCP_TOKEN      # random string you invent
 *   wrangler deploy
 *
 * Then add https://<your-worker>.workers.dev/mcp/<MCP_TOKEN> as a custom
 * connector URL in Claude.
 */

const GITHUB_API = "https://api.github.com";

const TOOLS = [
  {
    name: "get_file",
    description:
      "Read a file or list a directory from any branch, tag, or commit of a GitHub repository (works for private repos, text and binary alike). Pass ref (alias: branch) to read a non-default branch — the returned SHA is then that branch's blob SHA. For text files the response opens with a 'SHA: <blob sha>' line (plus 'REF: <ref>' when you asked for one), a blank line, then the content. You do not normally need this SHA to write: push_file looks it up from the target branch by itself. Binary files (images, archives, fonts, PDFs) are detected automatically and returned as base64 with an 'ENCODING: base64' header; images are also rendered inline so you can see them. For directories, returns a listing.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner (user or org)" },
        repo: { type: "string", description: "Repository name" },
        path: { type: "string", description: "Path to file or directory. Use '' or '/' for repo root." },
        ref: { type: "string", description: "Branch, tag, or commit SHA to read from. Defaults to the repo's default branch." },
        branch: { type: "string", description: "Alias for ref, for when you are reading a branch. Ignored if ref is also given." },
        encoding: {
          type: "string",
          enum: ["auto", "text", "base64"],
          description:
            "How to return file content. 'auto' (default) returns text when the bytes are valid UTF-8 and base64 otherwise. 'text' errors on binary. 'base64' always returns base64 — use it when you intend to copy a file verbatim.",
        },
        max_bytes: {
          type: "number",
          description:
            "Inline size ceiling. Defaults to 1000000 for text and 262144 for binary. Files over the ceiling return metadata plus a short-lived pre-authorized download URL instead of content. Raising this for a large binary is expensive — base64 inflates it by a third.",
        },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "get_issue",
    description: "Get details and/or comment thread for a specific issue or pull request.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        issue_number: { type: "number" },
        include_comments: { type: "boolean", description: "Also fetch the comment thread. Defaults to true." },
      },
      required: ["owner", "repo", "issue_number"],
    },
  },
  {
    name: "add_issue_comment",
    description: "Add a comment to an existing issue or pull request.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        issue_number: { type: "number" },
        body: { type: "string" },
      },
      required: ["owner", "repo", "issue_number", "body"],
    },
  },
  {
    name: "update_issue",
    description:
      "Edit an existing issue: change title/body, add labels or assignees, and/or close or reopen it. To close, pass state='closed' (optionally with state_reason). To reopen, pass state='open'. Only the fields you provide are changed.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        issue_number: { type: "number" },
        title: { type: "string" },
        body: { type: "string" },
        state: { type: "string", enum: ["open", "closed"], description: "Set to 'closed' to close, 'open' to reopen." },
        state_reason: {
          type: "string",
          enum: ["completed", "not_planned", "reopened"],
          description: "Reason when changing state. Use 'completed' or 'not_planned' when closing.",
        },
        labels: { type: "array", items: { type: "string" }, description: "Replaces the full label set." },
        assignees: { type: "array", items: { type: "string" }, description: "Replaces the full assignee set (GitHub logins)." },
      },
      required: ["owner", "repo", "issue_number"],
    },
  },
  {
    name: "push_file",
    description:
      "Create or update a single file in a GitHub repository in one commit, on any branch. The blob SHA of the file being replaced is looked up from the target branch automatically, so owner/repo/path/content/message/branch is always enough — you do NOT need a get_file round trip first, and this works the same on a non-default branch as on the default one. The response reports the new blob SHA, so consecutive writes to the same file never need a read in between. Handles binary files: set content_encoding='base64' and pass base64 content (for example the base64 a get_file call returned).",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        path: { type: "string", description: "Path where the file should be created/updated" },
        content: {
          type: "string",
          description: "New full file content. Plain text by default; base64 when content_encoding='base64'.",
        },
        content_encoding: {
          type: "string",
          enum: ["text", "base64"],
          description:
            "How 'content' is encoded. Defaults to 'text'. Use 'base64' for binary files — the content is committed byte-for-byte and is NOT re-encoded.",
        },
        message: { type: "string", description: "Commit message" },
        branch: { type: "string", description: "Branch to commit to. Must already exist — use create_branch first if it doesn't." },
        sha: {
          type: "string",
          description:
            "Blob SHA of the file being replaced. Optional — looked up from the target branch when omitted, for both new and existing files. Pass it only as an optimistic-concurrency guard: the write then fails instead of retrying if the file changed since you read it.",
        },
      },
      required: ["owner", "repo", "path", "content", "message", "branch"],
    },
  },
  {
    name: "delete_file",
    description:
      "Delete a single file from a GitHub repository in one commit. The blob SHA is looked up from the branch automatically, so you normally only need owner/repo/path/message/branch. Removes one file per call — for a directory, delete its files individually.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        path: { type: "string", description: "Path of the file to delete" },
        message: { type: "string", description: "Commit message" },
        branch: { type: "string", description: "Branch to commit the deletion to" },
        sha: {
          type: "string",
          description:
            "Blob SHA of the file being deleted. Optional — looked up from the branch when omitted. Pass it to guard against deleting a file that changed since you read it.",
        },
      },
      required: ["owner", "repo", "path", "message", "branch"],
    },
  },
  {
    name: "list_issues",
    description: "List issues in a GitHub repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        state: { type: "string", enum: ["open", "closed", "all"], description: "Defaults to 'open'." },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "create_issue",
    description: "Create a new issue in a GitHub repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        labels: { type: "array", items: { type: "string" }, description: "Labels to apply to the new issue." },
        assignees: { type: "array", items: { type: "string" }, description: "GitHub logins to assign." },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    name: "create_pr",
    description: "Create a pull request in a GitHub repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        head: { type: "string", description: "Branch containing your changes" },
        base: { type: "string", description: "Branch you want to merge into" },
        body: { type: "string" },
      },
      required: ["owner", "repo", "title", "head", "base"],
    },
  },
  {
    name: "create_repo",
    description: "Create a new GitHub repository under your account.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        private: { type: "boolean", description: "Defaults to true." },
        auto_init: { type: "boolean", description: "Initialize with a README. Defaults to false." },
      },
      required: ["name"],
    },
  },
  {
    name: "get_repo",
    description: "Get basic metadata for a repository. Useful as a quick access/sanity check.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "list_repos",
    description: "List repositories you own or can access, most recently updated first.",
    inputSchema: {
      type: "object",
      properties: {
        visibility: { type: "string", enum: ["all", "public", "private"], description: "Defaults to 'all'." },
      },
    },
  },
  {
    name: "create_branch",
    description:
      "Create a new branch from an existing branch (or the repo's default branch). Use this before push_file when committing to a branch that doesn't exist yet.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        branch: { type: "string", description: "Name of the new branch to create." },
        from_branch: { type: "string", description: "Branch to base it on. Defaults to the repo's default branch." },
      },
      required: ["owner", "repo", "branch"],
    },
  },
  {
    name: "list_branches",
    description:
      "List a repository's branches with their head commits, marking the default branch. Use it to get an exact branch name before reading from or pushing to one, or when a ref was rejected as not found.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "get_pr",
    description:
      "Get details for a pull request: state, mergeability, head/base branches, and change stats. Set include_files to also list the changed files.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        pull_number: { type: "number" },
        include_files: { type: "boolean", description: "Also list changed files. Defaults to false." },
      },
      required: ["owner", "repo", "pull_number"],
    },
  },
  {
    name: "list_prs",
    description: "List pull requests in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        state: { type: "string", enum: ["open", "closed", "all"], description: "Defaults to 'open'." },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "merge_pr",
    description: "Merge a pull request.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        pull_number: { type: "number" },
        merge_method: { type: "string", enum: ["merge", "squash", "rebase"], description: "Defaults to 'merge'." },
        commit_title: { type: "string" },
        commit_message: { type: "string" },
      },
      required: ["owner", "repo", "pull_number"],
    },
  },
  {
    name: "list_commits",
    description: "List recent commits on a branch (or the default branch).",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        sha: { type: "string", description: "Branch, tag, or commit SHA to start from. Defaults to the default branch." },
        path: { type: "string", description: "Only commits touching this path." },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "get_commit",
    description: "Get a single commit: message, author, and the files it changed with additions/deletions.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        ref: { type: "string", description: "Commit SHA (or branch/tag)." },
      },
      required: ["owner", "repo", "ref"],
    },
  },
  {
    name: "search_code",
    description:
      "Search code across GitHub. Pass a GitHub code-search query. Optionally scope to a single repo with owner+repo.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Code search query, e.g. 'callTool language:js'." },
        owner: { type: "string", description: "Optional: scope to this owner's repo (pair with repo)." },
        repo: { type: "string", description: "Optional: scope to this repo (pair with owner)." },
      },
      required: ["query"],
    },
  },
  {
    name: "search_issues",
    description:
      "Search issues and pull requests across GitHub. Pass a GitHub issues-search query (add 'is:issue' or 'is:pr' to filter). Useful to check for duplicates before create_issue.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Issue search query, e.g. 'repo:owner/name is:issue is:open bug'." },
      },
      required: ["query"],
    },
  },
  {
    name: "list_workflows",
    description:
      "List a repository's GitHub Actions workflows: id, name, state (active/disabled), and file path. Use it to get the workflow_id or file name to pass to list_workflow_runs; for what a workflow actually costs, run list_workflow_runs with include_timing.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "list_workflow_runs",
    description:
      "List recent GitHub Actions runs for a repository with their actual wall-clock durations — real run history, not an estimate read off the workflow YAML. Filter by workflow, branch, event, status, or creation date. Pass include_timing=true to also get each run's billable minutes (summed from its jobs, each rounded up to a whole minute as GitHub bills them) plus a per-workflow rollup showing which workflow actually dominates spend. Timing costs one extra API call per run, so only the first 25 listed runs are timed.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        workflow_id: {
          type: "string",
          description: "Restrict to one workflow: either its numeric id or its file name, e.g. 'ci.yml'. Omit for all workflows.",
        },
        branch: { type: "string", description: "Only runs on this branch." },
        event: { type: "string", description: "Only runs triggered by this event, e.g. 'schedule', 'push', 'pull_request'." },
        status: {
          type: "string",
          description:
            "Only runs in this state or conclusion, e.g. 'completed', 'in_progress', 'success', 'failure', 'cancelled', 'timed_out'.",
        },
        created: {
          type: "string",
          description: "Date filter in GitHub search syntax, e.g. '>=2026-07-01' or '2026-07-01..2026-07-31'.",
        },
        per_page: { type: "number", description: "How many runs to list, 1-100. Defaults to 20." },
        include_timing: {
          type: "boolean",
          description:
            "Also compute billable minutes per run, a total, and a per-workflow rollup. Defaults to false. Only the first 25 runs are timed; the response says so when it truncates.",
        },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "get_actions_billing",
    description:
      "Actions minutes and spend for an account. On GitHub's enhanced billing platform this returns a per-repository and per-SKU breakdown for the requested month; otherwise it falls back to the legacy Actions billing summary (total/included/paid minutes plus a per-OS breakdown). Defaults to the authenticated user — pass account plus account_type='org' for an organization.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "User login or organization name. Defaults to the authenticated user." },
        account_type: { type: "string", enum: ["user", "org"], description: "Defaults to 'user'." },
        year: { type: "number", description: "Year to report on. Enhanced billing only; defaults to the current billing period." },
        month: { type: "number", description: "Month 1-12. Enhanced billing only; defaults to the current billing period." },
        product: {
          type: "string",
          description: "Which product's usage to report: 'actions' (default) or 'all'. Enhanced billing only.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_project",
    description:
      "Read a GitHub Project (the new Projects, v2) by owner and number: its title, URL, and every field with its type — and, for single-select fields, the option names. Call this to learn a project's field names before update_project_item_field. Works for user- and org-owned projects alike. Needs a token with the 'project' (or 'read:project') scope.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "User or organization that owns the project, e.g. 'octocat'." },
        number: { type: "number", description: "Project number, as in github.com/users/<owner>/projects/<number>." },
      },
      required: ["owner", "number"],
    },
  },
  {
    name: "list_project_items",
    description:
      "List a project's items — issues, pull requests and draft items — with each item's id and its field values (e.g. Stage=Private alpha, Approvals=5). The item id is what update_project_item_field takes. Paginates: pass the returned cursor as 'after' for the next page.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        number: { type: "number" },
        first: { type: "number", description: "Items per page, 1-100. Defaults to 50." },
        after: { type: "string", description: "Cursor from a previous page." },
        include_archived: { type: "boolean", description: "Also list archived items. Defaults to false." },
      },
      required: ["owner", "number"],
    },
  },
  {
    name: "add_project_item",
    description:
      "Add an issue or pull request to a project (content_owner/content_repo/content_number), or create a draft item (draft_title, draft_body) for something with no issue behind it. Adding content that is already in the project returns the existing item rather than a duplicate. Optionally set field values in the same call via 'fields', exactly as update_project_item_field takes them.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Project owner." },
        number: { type: "number", description: "Project number." },
        content_owner: { type: "string", description: "Owner of the issue/PR's repository. Defaults to the project owner." },
        content_repo: { type: "string", description: "Repository of the issue/PR to add." },
        content_number: { type: "number", description: "Issue or PR number to add." },
        draft_title: { type: "string", description: "Title for a draft item. Use instead of content_*." },
        draft_body: { type: "string", description: "Body for a draft item." },
        fields: {
          type: "object",
          additionalProperties: true,
          description: "Field values to set on the new item: {\"Field name\": value}. See update_project_item_field.",
        },
      },
      required: ["owner", "number"],
    },
  },
  {
    name: "update_project_item_field",
    description:
      "Set one or more field values on a project item, by field name: {\"Stage\": \"Public alpha\", \"Approvals\": 5, \"Last contact\": \"2026-09-28\", \"Next step\": \"Widen play area\"}. Single-select values are matched to option names case-insensitively; numbers are numbers; dates are YYYY-MM-DD; null or \"\" clears a field. All fields are written in one request. Built-in fields other than Status (Title, Assignees, Labels, Milestone, Repository) cannot be set this way.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Project owner." },
        number: { type: "number", description: "Project number." },
        item_id: { type: "string", description: "Project item id (PVTI_...), from list_project_items or add_project_item." },
        fields: {
          type: "object",
          additionalProperties: true,
          description: "{\"Field name\": value} — value is a string, number, or null to clear.",
        },
      },
      required: ["owner", "number", "item_id", "fields"],
    },
  },
];

// --- base64 / text helpers -------------------------------------------------
// These deliberately avoid escape()/unescape(): decodeURIComponent(escape(...))
// throws URIError on any byte sequence that isn't valid UTF-8, which is every
// binary file. Everything below goes through bytes.

function bytesToBase64(bytes) {
  let bin = "";
  const CHUNK = 0x8000; // stay under the argument limit of Function.apply
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(String(b64).replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function b64EncodeUtf8(str) {
  return bytesToBase64(new TextEncoder().encode(str));
}

// Strict: throws TypeError if the bytes aren't valid UTF-8. Callers use that
// as the binary/text test rather than guessing from the file extension.
function decodeUtf8Strict(bytes) {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

// Percent-encode each path segment so paths with spaces, '#', '?' etc. survive.
function encodePath(path) {
  return String(path == null ? "" : path)
    .split("/")
    .filter((seg) => seg.length)
    .map(encodeURIComponent)
    .join("/");
}

// Inline size ceilings for get_file, overridable per call via max_bytes.
const TEXT_MAX_BYTES = 1_000_000; // GitHub's own contents-API inline ceiling
const BINARY_MAX_BYTES = 262_144; // base64 inflates 33% and rides the context

const MIME_BY_EXT = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  bmp: "image/bmp",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  wasm: "application/wasm",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
};

// The only image types Claude accepts as an inline image content block.
const IMAGE_BLOCK_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function mimeForPath(path) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(path || ""));
  const ext = m ? m[1].toLowerCase() : "";
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

// --- Actions timing / billing helpers -------------------------------------

// Per-run job timing costs one extra API call per run, and a Worker request has
// a finite subrequest budget (50 on the free plan), so timing is capped.
const TIMING_MAX_RUNS = 25;

function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}h${m}m${s}s` : m ? `${m}m${s}s` : `${s}s`;
}

function osFromLabels(labels) {
  const l = (labels || []).map((x) => String(x).toLowerCase()).join(" ");
  if (l.includes("windows")) return "WINDOWS";
  if (l.includes("macos") || l.includes("mac-")) return "MACOS";
  if (l.includes("ubuntu") || l.includes("linux")) return "UBUNTU";
  return "OTHER";
}

// Billable minutes for one run, derived from per-job start/finish times.
//
// We deliberately do NOT use /actions/runs/{id}/timing: on accounts migrated to
// GitHub's enhanced billing platform that endpoint still answers 200 but reports
// total_ms: 0 for every job, which reads as "this run was free" when it wasn't.
// Job timestamps are always populated, and GitHub bills each job rounded up to
// the whole minute, so summing ceil(job duration) reproduces the charge.
async function runBillableMinutes(env, owner, repo, runId) {
  const data = await gh(env, `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100&filter=latest`);
  const jobs = data.jobs || [];
  const byOs = {};
  let machineMs = 0;
  let timed = 0;
  for (const j of jobs) {
    if (!j.started_at || !j.completed_at) continue;
    const ms = new Date(j.completed_at) - new Date(j.started_at);
    if (!(ms >= 0)) continue;
    machineMs += ms;
    timed++;
    const os = osFromLabels(j.labels);
    byOs[os] = (byOs[os] || 0) + Math.max(1, Math.ceil(ms / 60000));
  }
  return { byOs, machineMs, jobs: jobs.length, timed, truncated: (data.total_count || jobs.length) > jobs.length };
}

function formatByOs(byOs) {
  const entries = Object.entries(byOs || {}).sort((a, b) => b[1] - a[1]);
  return entries.length ? entries.map(([os, min]) => `${os} ${min}`).join(", ") : "none";
}

function addByOs(totals, byOs) {
  for (const [os, min] of Object.entries(byOs || {})) totals[os] = (totals[os] || 0) + min;
}

function sumByOs(byOs) {
  return Object.values(byOs || {}).reduce((t, n) => t + n, 0);
}

async function gh(env, path, options = {}) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gh-mcp-worker",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    const msg = json && json.message ? json.message : `GitHub API error ${res.status}`;
    const err = new Error(`${res.status} ${msg}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// GitHub's GraphQL API. Used as a fallback for single-object reads when the
// REST endpoint 5xxs (e.g. the recurring Issues-API incidents where
// GET /issues/:n returns 503 while GraphQL stays up).
async function ghGraphQL(env, query, variables) {
  const res = await fetch(`${GITHUB_API}/graphql`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "gh-mcp-worker",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = new Error(`${res.status} GraphQL request failed`);
    err.status = res.status;
    throw err;
  }
  if (json && json.errors && json.errors.length) {
    // A missing scope yields one error per field touched; say it once.
    if (json.errors.every((e) => e.type === "INSUFFICIENT_SCOPES")) {
      const m = /requires one of the following scopes: \[([^\]]*)\]/.exec(json.errors[0].message);
      throw new Error(`GraphQL: the GitHub token lacks the required scope${m ? ` (one of ${m[1]})` : ""}`);
    }
    throw new Error(`GraphQL: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  return json ? json.data : null;
}

// Fetch an issue OR pull request via GraphQL, formatted to match the REST
// get_issue output. issueOrPullRequest resolves either type by number.
async function getIssueViaGraphQL(env, owner, repo, number, includeComments) {
  const query = `
    query($owner:String!,$repo:String!,$number:Int!,$includeComments:Boolean!){
      repository(owner:$owner,name:$repo){
        issueOrPullRequest(number:$number){
          __typename
          ... on Issue {
            number state title body
            comments(first:100) @include(if:$includeComments){ nodes { author { login } createdAt body } }
          }
          ... on PullRequest {
            number state title body
            comments(first:100) @include(if:$includeComments){ nodes { author { login } createdAt body } }
          }
        }
      }
    }`;
  const data = await ghGraphQL(env, query, { owner, repo, number, includeComments });
  const n = data && data.repository && data.repository.issueOrPullRequest;
  if (!n) throw new Error(`#${number} not found in ${owner}/${repo}`);
  const state = String(n.state).toLowerCase();
  let out = `#${n.number} [${state}] ${n.title}\n\n${n.body || "(no description)"}`;
  if (includeComments) {
    const comments = (n.comments && n.comments.nodes) || [];
    if (comments.length) {
      out += `\n\n--- Comments (${comments.length}) ---\n`;
      out += comments
        .map((c) => `[${c.author ? c.author.login : "ghost"}, ${c.createdAt}]\n${c.body}`)
        .join("\n\n");
    } else {
      out += "\n\n(no comments)";
    }
  }
  return out + "\n\n(fetched via GraphQL fallback; REST issues API returned 5xx)";
}

// Fetch a pull request via GraphQL, formatted to match the REST get_pr output.
async function getPrViaGraphQL(env, owner, repo, number, includeFiles) {
  const query = `
    query($owner:String!,$repo:String!,$number:Int!,$includeFiles:Boolean!){
      repository(owner:$owner,name:$repo){
        pullRequest(number:$number){
          number state merged title body url
          additions deletions changedFiles mergeable
          headRefName baseRefName
          files(first:100) @include(if:$includeFiles){ nodes { path additions deletions changeType } }
        }
      }
    }`;
  const data = await ghGraphQL(env, query, { owner, repo, number, includeFiles });
  const pr = data && data.repository && data.repository.pullRequest;
  if (!pr) throw new Error(`PR #${number} not found in ${owner}/${repo}`);
  const state = pr.merged ? "closed" : String(pr.state).toLowerCase();
  const mergeable = pr.mergeable === "MERGEABLE" ? true : pr.mergeable === "CONFLICTING" ? false : "unknown";
  let out = `#${pr.number} [${state}${pr.merged ? "/merged" : ""}] ${pr.title}\n`;
  out += `${pr.headRefName} -> ${pr.baseRefName} | mergeable: ${mergeable} | +${pr.additions}/-${pr.deletions} across ${pr.changedFiles} file(s)\n`;
  out += `${pr.url}\n\n${pr.body || "(no description)"}`;
  if (includeFiles) {
    const files = (pr.files && pr.files.nodes) || [];
    out += `\n\n--- Files (${files.length}) ---\n`;
    out += files.map((f) => `${String(f.changeType).toLowerCase()} ${f.path} (+${f.additions}/-${f.deletions})`).join("\n");
  }
  return out + "\n\n(fetched via GraphQL fallback; REST PR API returned 5xx)";
}

// --- Projects (v2) helpers -------------------------------------------------
// Projects v2 exist only in GraphQL. repositoryOwner resolves a login whether it
// is a user or an org, and both implement ProjectV2Owner, so one query serves
// both. A token without the 'project' scope
// gets a GraphQL error naming the missing scope, which ghGraphQL passes through.

async function getProjectV2(env, owner, number) {
  const query = `
    query($owner:String!,$number:Int!){
      repositoryOwner(login:$owner){
        ... on ProjectV2Owner {
          projectV2(number:$number){
            id title url shortDescription closed
            fields(first:50){ nodes {
              ... on ProjectV2FieldCommon { id name dataType }
              ... on ProjectV2SingleSelectField { options { id name } }
            } }
          }
        }
      }
    }`;
  const data = await ghGraphQL(env, query, { owner, number });
  if (!data || !data.repositoryOwner) throw new Error(`No user or organization named ${owner}`);
  const p = data.repositoryOwner.projectV2;
  if (!p) throw new Error(`Project ${owner}/${number} not found`);
  p.fields = ((p.fields && p.fields.nodes) || []).filter((f) => f && f.id);
  return p;
}

// Encode one field value as the ProjectV2FieldValue input its type expects.
function projectFieldValue(field, raw) {
  switch (field.dataType) {
    case "TEXT":
      return { text: String(raw) };
    case "NUMBER": {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`${field.name} is a number field; got ${JSON.stringify(raw)}`);
      return { number: n };
    }
    case "DATE": {
      const s = String(raw);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`${field.name} is a date field; use YYYY-MM-DD, got ${JSON.stringify(raw)}`);
      return { date: s };
    }
    case "SINGLE_SELECT": {
      const want = String(raw).trim().toLowerCase();
      const opt = (field.options || []).find((o) => o.name.toLowerCase() === want);
      if (!opt) {
        const names = (field.options || []).map((o) => o.name).join(", ");
        throw new Error(`"${raw}" is not an option of ${field.name}. Options: ${names}`);
      }
      return { singleSelectOptionId: opt.id };
    }
    default:
      throw new Error(`${field.name} is a ${field.dataType} field, which cannot be set through the API this way`);
  }
}

// Set several fields on one item in a single GraphQL request (one aliased
// mutation per field). Every name and value is validated before anything is
// sent, so a typo fails the whole call rather than half-writing it.
async function setProjectItemFields(env, project, itemId, fields) {
  const entries = Object.entries(fields || {});
  if (!entries.length) return [];
  const byName = new Map(project.fields.map((f) => [f.name.toLowerCase(), f]));
  const decls = ["$p:ID!", "$i:ID!"];
  const ops = [];
  const vars = { p: project.id, i: itemId };
  const done = [];
  entries.forEach(([name, raw], k) => {
    const field = byName.get(String(name).toLowerCase());
    if (!field) {
      throw new Error(`No field "${name}" in ${project.title}. Fields: ${project.fields.map((f) => f.name).join(", ")}`);
    }
    decls.push(`$f${k}:ID!`);
    vars[`f${k}`] = field.id;
    if (raw === null || raw === undefined || raw === "") {
      ops.push(`c${k}: clearProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f${k}}){ clientMutationId }`);
      done.push(`${field.name} cleared`);
    } else {
      decls.push(`$v${k}:ProjectV2FieldValue!`);
      const value = projectFieldValue(field, raw);
      vars[`v${k}`] = value;
      ops.push(
        `u${k}: updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f${k},value:$v${k}}){ clientMutationId }`,
      );
      // Echo the option's own spelling, not the case-insensitive match typed.
      const opt = value.singleSelectOptionId && field.options.find((o) => o.id === value.singleSelectOptionId);
      done.push(`${field.name}=${opt ? opt.name : raw}`);
    }
  });
  await ghGraphQL(env, `mutation(${decls.join(",")}){\n${ops.join("\n")}\n}`, vars);
  return done;
}

function formatProjectItem(it) {
  const c = it.content || {};
  let head;
  if (it.type === "DRAFT_ISSUE") head = `DRAFT ${c.title}`;
  else if (c.repository) head = `${c.repository.nameWithOwner}#${c.number} [${String(c.state).toLowerCase()}] ${c.title}`;
  else head = `${it.type} (content not visible to this token)`;
  const vals = ((it.fieldValues && it.fieldValues.nodes) || [])
    .filter((v) => v && v.field && v.field.name && v.field.name !== "Title")
    .map((v) => `${v.field.name}=${v.text ?? v.number ?? v.date ?? v.name ?? v.title}`);
  return `${it.id}${it.isArchived ? " (archived)" : ""} | ${head}` + (vals.length ? `\n    ${vals.join(" · ")}` : "");
}

// --- contents helpers ------------------------------------------------------

// The contents API is edge-cached by URL, and it caches misses as well as hits:
// once a path has 404'd, that 404 is served again for roughly a minute even
// after the file exists. That is what makes "write to a branch, then read the
// file back to get its blob SHA" fail — and it fails hardest on a branch you
// just created, where every path 404s at least once. Reading a stale 200 is the
// same hazard in reverse: a blob SHA from before someone else's commit sends
// the next write into a 409.
//
// Unknown query params are ignored by the API but are part of the cache key, so
// a nonce buys an uncached answer on every read. Blobs are content-addressed
// and immutable, so /git/blobs needs none of this.
function contentsPath(owner, repo, path, ref) {
  const qs = new URLSearchParams();
  if (ref) qs.set("ref", ref);
  qs.set("_", crypto.randomUUID());
  return `/repos/${owner}/${repo}/contents/${encodePath(path)}?${qs.toString()}`;
}

function splitPath(path) {
  const clean = String(path == null ? "" : path).replace(/^\/+|\/+$/g, "");
  const segments = clean.split("/");
  return { clean, name: segments[segments.length - 1], parent: segments.slice(0, -1).join("/") };
}

// The listing of a path's parent directory, or null when that isn't readable
// either. Cheap second opinion: the directory index and the per-path endpoint
// are separately consistent, and the listing entries already carry each file's
// blob SHA and size.
async function parentListing(env, owner, repo, path, ref) {
  try {
    const listing = await gh(env, contentsPath(owner, repo, splitPath(path).parent, ref));
    return Array.isArray(listing) ? listing : null;
  } catch {
    return null;
  }
}

// Metadata for one file on a specific branch/ref, or null when it isn't there.
// Used to resolve the blob SHA a write needs without making the caller do a
// get_file round trip first. A missing branch also lands here as null — the
// subsequent write reports that, and its message is the clearer one.
async function fileMetaOnRef(env, owner, repo, path, ref) {
  let meta;
  try {
    meta = await gh(env, contentsPath(owner, repo, path, ref));
  } catch (err) {
    if (err.status !== 404) throw err;
    // The per-path endpoint trails the directory index by a beat after a
    // commit, so a file the parent can already see is real, not absent. Taking
    // the 404 at face value here is what turns "write, then read back its SHA"
    // into a phantom failure.
    const hit = (await parentListing(env, owner, repo, path, ref) || []).find(
      (e) => e.name === splitPath(path).name && e.type === "file",
    );
    return hit || null;
  }
  if (Array.isArray(meta)) {
    throw new Error(`${path} is a directory on ${ref} of ${owner}/${repo} — this tool acts on a single file.`);
  }
  return meta;
}

// A bare "404 Not Found" from the contents API is ambiguous: "no such ref", "no
// such path on that ref", or "the path is there but this endpoint hasn't caught
// up". Reading it as the first makes non-default-branch reads look unsupported
// when they aren't. Spend a couple of calls on the error path to tell them
// apart — and when it's the third, return the file rather than an error. The
// listing entry has the blob SHA and size, which is all the caller needs; the
// content itself comes from the blobs API, which is content-addressed.
async function recoverContents404(env, owner, repo, path, ref, err) {
  const where = ref ? `ref '${ref}'` : "the default branch";

  if (/No commit found for the ref/i.test(err.message || "")) {
    let known = "";
    try {
      const branches = await gh(env, `/repos/${owner}/${repo}/branches?per_page=100`);
      const names = branches.map((b) => b.name);
      if (names.length) known = ` Branches in ${owner}/${repo}: ${names.join(", ")}.`;
    } catch {
      // no branch list available — the main message still stands
    }
    throw new Error(
      `No branch, tag, or commit '${ref}' in ${owner}/${repo}. Reading a non-default branch is supported — ` +
        `it is this ref that doesn't resolve.${known}`,
    );
  }

  const { clean, name, parent } = splitPath(path);
  const siblings = await parentListing(env, owner, repo, path, ref);

  if (!siblings) {
    throw new Error(
      `${clean || "(root)"} doesn't exist on ${where} of ${owner}/${repo}` +
        `${parent ? `, and neither does '${parent}/'` : ""}. The ref resolved, the path didn't. ` +
        `To create the file there, call push_file with that branch and no sha.`,
    );
  }

  const hit = siblings.find((e) => e.name === name);
  if (hit && hit.type === "file") return hit;
  if (hit) throw new Error(`${clean} on ${where} of ${owner}/${repo} is a ${hit.type}, not a file.`);

  const names = siblings.slice(0, 40).map((e) => e.name);
  throw new Error(
    `${clean || "(root)"} doesn't exist on ${where} of ${owner}/${repo} — the ref resolved, the path didn't. ` +
      `${parent ? `'${parent}/'` : "The repo root"} on ${where} contains: ` +
      `${names.join(", ")}${siblings.length > 40 ? ", …" : ""}. ` +
      `To create the file there, call push_file with that branch and no sha.`,
  );
}

async function callTool(name, args, env) {
  switch (name) {
    case "get_file": {
      const { owner, repo, path = "", encoding = "auto" } = args;
      // `branch` is an alias: an agent looking for the branch knob on a read
      // shouldn't have to know GitHub calls it a ref.
      const ref = args.ref || args.branch || undefined;
      const explicitMax = typeof args.max_bytes === "number" ? args.max_bytes : null;
      const refLine = ref ? `REF: ${ref}\n` : "";
      let data;
      try {
        data = await gh(env, contentsPath(owner, repo, path, ref));
      } catch (err) {
        if (err.status !== 404) throw err;
        // Either returns the file (recovered from the directory index) or
        // throws an error that says which half of the 404 it actually was.
        data = await recoverContents404(env, owner, repo, path, ref, err);
      }

      if (Array.isArray(data)) {
        const listing = data.map((e) => `${e.type === "dir" ? "[dir] " : "      "}${e.path}`).join("\n");
        if (!listing) return ref ? `(empty directory on ${ref})` : "(empty directory)";
        return ref ? `${refLine}\n${listing}` : listing;
      }
      if (data.type && data.type !== "file") {
        // submodule or symlink — no content to return
        return JSON.stringify(data, null, 2);
      }

      const tooBig = (limit) =>
        `SHA: ${data.sha}\n${refLine}SIZE: ${data.size} bytes\nMIME: ${mimeForPath(data.path || path)}\n\n` +
        `(Not inlined: ${data.size} bytes exceeds the ${limit}-byte ceiling. Raise it with max_bytes ` +
        `if you really need the content in-context, or download it directly — this URL is pre-authorized ` +
        `for this private repo and expires in a few minutes:)\n${data.download_url || "(no download_url)"}`;

      // Refuse oversized files before spending a second request on the blob API.
      if (data.size > (explicitMax ?? TEXT_MAX_BYTES)) {
        return tooBig(explicitMax ?? TEXT_MAX_BYTES);
      }

      // Files over 1 MB come back with encoding "none" and empty content; the
      // Git blobs API serves those (up to 100 MB) as base64.
      let b64 = data.encoding === "base64" ? data.content || "" : null;
      if (b64 === null || (b64 === "" && data.size > 0)) {
        const blob = await gh(env, `/repos/${owner}/${repo}/git/blobs/${data.sha}`);
        if (blob.encoding !== "base64") {
          return `SHA: ${data.sha}\n${refLine}SIZE: ${data.size} bytes\n\n(Unsupported blob encoding '${blob.encoding}'.)`;
        }
        b64 = blob.content || "";
      }

      const bytes = base64ToBytes(b64);
      const mime = mimeForPath(data.path || path);

      let text = null;
      if (encoding !== "base64") {
        try {
          text = decodeUtf8Strict(bytes);
        } catch {
          if (encoding === "text") {
            throw new Error(
              `${data.path} is not valid UTF-8 (${data.size} bytes, ${mime}). ` +
                `Call get_file again with encoding='base64' to read it as binary.`
            );
          }
          text = null; // encoding === "auto": fall through to the binary path
        }
      }

      if (text !== null) {
        return `SHA: ${data.sha}\n${refLine}\n${text}`;
      }

      // Binary from here on.
      if (data.size > (explicitMax ?? BINARY_MAX_BYTES)) {
        return tooBig(explicitMax ?? BINARY_MAX_BYTES);
      }

      const clean = bytesToBase64(bytes); // normalized: no newlines from the blob API
      const header =
        `SHA: ${data.sha}\n${refLine}ENCODING: base64\nSIZE: ${data.size} bytes\nMIME: ${mime}\n\n` +
        `(Binary file. To write it back, pass this base64 verbatim to push_file with content_encoding='base64'.)`;

      if (IMAGE_BLOCK_MIMES.has(mime) && encoding === "auto") {
        return {
          content: [
            { type: "text", text: header },
            { type: "image", data: clean, mimeType: mime },
          ],
        };
      }
      return `${header}\n\n${clean}`;
    }

    case "get_issue": {
      const { owner, repo, issue_number, include_comments = true } = args;
      try {
        const issue = await gh(env, `/repos/${owner}/${repo}/issues/${issue_number}`);
        let out = `#${issue.number} [${issue.state}] ${issue.title}\n\n${issue.body || "(no description)"}`;
        if (include_comments) {
          const comments = await gh(env, `/repos/${owner}/${repo}/issues/${issue_number}/comments?per_page=100`);
          if (comments.length) {
            out += `\n\n--- Comments (${comments.length}) ---\n`;
            out += comments
              .map((c) => `[${c.user.login}, ${c.created_at}]\n${c.body}`)
              .join("\n\n");
          } else {
            out += "\n\n(no comments)";
          }
        }
        return out;
      } catch (err) {
        if (!(err.status >= 500)) throw err; // only fall back on GitHub 5xx
        return await getIssueViaGraphQL(env, owner, repo, issue_number, include_comments);
      }
    }

    case "add_issue_comment": {
      const { owner, repo, issue_number, body } = args;
      const data = await gh(env, `/repos/${owner}/${repo}/issues/${issue_number}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      return `Added comment ${data.id} to #${issue_number}: ${data.html_url}`;
    }

    case "update_issue": {
      const { owner, repo, issue_number, title, body, state, state_reason, labels, assignees } = args;
      const patch = {};
      if (title !== undefined) patch.title = title;
      if (body !== undefined) patch.body = body;
      if (state !== undefined) patch.state = state;
      if (state_reason !== undefined) patch.state_reason = state_reason;
      if (labels !== undefined) patch.labels = labels;
      if (assignees !== undefined) patch.assignees = assignees;
      if (Object.keys(patch).length === 0) {
        throw new Error("Nothing to update: provide at least one of title, body, state, state_reason, labels, assignees.");
      }
      const data = await gh(env, `/repos/${owner}/${repo}/issues/${issue_number}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      return `Updated issue #${data.number} [${data.state}${data.state_reason ? `/${data.state_reason}` : ""}]: ${data.html_url}`;
    }

    case "push_file": {
      const { owner, repo, path, content, message, branch, content_encoding = "text" } = args;
      let encoded;
      if (content_encoding === "base64") {
        // Pass through untouched — encoding it again would commit a text file
        // containing base64 instead of the binary itself.
        encoded = String(content).replace(/\s/g, "");
        if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
          throw new Error("content_encoding='base64' but content is not valid base64.");
        }
        try {
          atob(encoded);
        } catch {
          throw new Error("content_encoding='base64' but content failed to decode.");
        }
      } else if (content_encoding === "text") {
        encoded = b64EncodeUtf8(content);
      } else {
        throw new Error(`Unknown content_encoding '${content_encoding}' — use 'text' or 'base64'.`);
      }

      const put = (blobSha) => {
        const body = { message, content: encoded, branch };
        if (blobSha) body.sha = blobSha;
        return gh(env, `/repos/${owner}/${repo}/contents/${encodePath(path)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      };

      // A caller-supplied sha is an optimistic-concurrency guard, so it is used
      // as given and never silently replaced. With no sha we resolve one from
      // the branch being written — which is what makes writing to a non-default
      // branch a single call, on the branch's own blob rather than the default
      // branch's.
      const supplied = args.sha;
      let sha = supplied;
      if (!sha) {
        const meta = await fileMetaOnRef(env, owner, repo, path, branch);
        sha = meta ? meta.sha : undefined;
      }

      let data;
      try {
        data = await put(sha);
      } catch (err) {
        const conflict = err.status === 409 || err.status === 422;
        if (!conflict) throw err;
        if (supplied) {
          throw new Error(
            `${err.message} — the sha you passed is not ${path}'s current blob on ${branch}. ` +
              `Either the file changed since you read it, or the sha came from a different branch. ` +
              `Re-read with get_file (ref='${branch}'), or omit sha to let push_file resolve it.`,
          );
        }
        // Lost a race between the lookup and the write: re-read and retry once.
        const fresh = await fileMetaOnRef(env, owner, repo, path, branch);
        const freshSha = fresh ? fresh.sha : undefined;
        if (freshSha === sha) throw err; // not the sha's fault — surface GitHub's message
        data = await put(freshSha);
        sha = freshSha;
      }
      // Hand back the new blob SHA: GitHub's per-path read can trail a commit by
      // a moment, so re-reading a file you just wrote is both an extra call and
      // the one moment the answer might be stale. This is authoritative.
      return (
        `Committed ${data.content.path} to ${branch} (${data.commit.sha.slice(0, 7)}) — ` +
        `${sha ? "updated existing file" : "created new file"}\nSHA: ${data.content.sha}`
      );
    }

    case "delete_file": {
      const { owner, repo, path, message, branch } = args;
      let sha = args.sha;
      if (!sha) {
        const meta = await fileMetaOnRef(env, owner, repo, path, branch);
        if (!meta) throw new Error(`${path} does not exist on branch ${branch} of ${owner}/${repo}.`);
        sha = meta.sha;
      }
      const data = await gh(env, `/repos/${owner}/${repo}/contents/${encodePath(path)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, branch, sha }),
      });
      return `Deleted ${path} from ${branch} (${data.commit.sha.slice(0, 7)})`;
    }

    case "list_issues": {
      const { owner, repo, state = "open" } = args;
      const data = await gh(env, `/repos/${owner}/${repo}/issues?state=${state}&per_page=50`);
      if (!data.length) return "(no issues)";
      return data
        .filter((i) => !i.pull_request)
        .map((i) => `#${i.number} [${i.state}] ${i.title}`)
        .join("\n");
    }

    case "create_issue": {
      const { owner, repo, title, body, labels, assignees } = args;
      const data = await gh(env, `/repos/${owner}/${repo}/issues`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body, labels, assignees }),
      });
      return `Created issue #${data.number}: ${data.html_url}`;
    }

    case "create_pr": {
      const { owner, repo, title, head, base, body } = args;
      const data = await gh(env, `/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, head, base, body }),
      });
      return `Created PR #${data.number}: ${data.html_url}`;
    }

    case "create_repo": {
      const { name, description, private: isPrivate = true, auto_init = false } = args;
      const data = await gh(env, `/user/repos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, private: isPrivate, auto_init }),
      });
      return `Created ${data.full_name} (${data.private ? "private" : "public"}): ${data.html_url}`;
    }

    case "get_repo": {
      const { owner, repo } = args;
      const data = await gh(env, `/repos/${owner}/${repo}`);
      return `${data.full_name} — ${data.private ? "private" : "public"} — default branch: ${data.default_branch} — ${data.description || "(no description)"}`;
    }

    case "list_repos": {
      const { visibility = "all" } = args;
      const data = await gh(env, `/user/repos?visibility=${visibility}&sort=updated&per_page=50`);
      if (!data.length) return "(no repositories)";
      return data
        .map((r) => `${r.full_name} [${r.private ? "private" : "public"}] — ${r.description || "(no description)"}`)
        .join("\n");
    }

    case "create_branch": {
      const { owner, repo, branch, from_branch } = args;
      let base = from_branch;
      if (!base) {
        const repoData = await gh(env, `/repos/${owner}/${repo}`);
        base = repoData.default_branch;
      }
      const baseRef = await gh(env, `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
      await gh(env, `/repos/${owner}/${repo}/git/refs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseRef.object.sha }),
      });
      return `Created branch ${branch} from ${base} (${baseRef.object.sha.slice(0, 7)})`;
    }

    case "list_branches": {
      const { owner, repo } = args;
      const [repoData, branches] = await Promise.all([
        gh(env, `/repos/${owner}/${repo}`),
        gh(env, `/repos/${owner}/${repo}/branches?per_page=100`),
      ]);
      if (!branches.length) return "(no branches)";
      return (
        `${branches.length} branch(es) in ${owner}/${repo}:\n` +
        branches
          .map(
            (b) =>
              `${b.name}${b.name === repoData.default_branch ? " [default]" : ""}` +
              `${b.protected ? " [protected]" : ""} — ${b.commit.sha.slice(0, 7)}`,
          )
          .join("\n")
      );
    }

    case "get_pr": {
      const { owner, repo, pull_number, include_files = false } = args;
      try {
        const pr = await gh(env, `/repos/${owner}/${repo}/pulls/${pull_number}`);
        let out = `#${pr.number} [${pr.state}${pr.merged ? "/merged" : ""}] ${pr.title}\n`;
        out += `${pr.head.ref} -> ${pr.base.ref} | mergeable: ${pr.mergeable === null ? "unknown" : pr.mergeable} | +${pr.additions}/-${pr.deletions} across ${pr.changed_files} file(s)\n`;
        out += `${pr.html_url}\n\n${pr.body || "(no description)"}`;
        if (include_files) {
          const files = await gh(env, `/repos/${owner}/${repo}/pulls/${pull_number}/files?per_page=100`);
          out += `\n\n--- Files (${files.length}) ---\n`;
          out += files.map((f) => `${f.status} ${f.filename} (+${f.additions}/-${f.deletions})`).join("\n");
        }
        return out;
      } catch (err) {
        if (!(err.status >= 500)) throw err; // only fall back on GitHub 5xx
        return await getPrViaGraphQL(env, owner, repo, pull_number, include_files);
      }
    }

    case "list_prs": {
      const { owner, repo, state = "open" } = args;
      const data = await gh(env, `/repos/${owner}/${repo}/pulls?state=${state}&per_page=50`);
      if (!data.length) return "(no pull requests)";
      return data.map((p) => `#${p.number} [${p.state}] ${p.title} (${p.head.ref} -> ${p.base.ref})`).join("\n");
    }

    case "merge_pr": {
      const { owner, repo, pull_number, merge_method = "merge", commit_title, commit_message } = args;
      const body = { merge_method };
      if (commit_title !== undefined) body.commit_title = commit_title;
      if (commit_message !== undefined) body.commit_message = commit_message;
      const data = await gh(env, `/repos/${owner}/${repo}/pulls/${pull_number}/merge`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return `Merged PR #${pull_number}${data.sha ? ` (${data.sha.slice(0, 7)})` : ""}: ${data.message || "merged"}`;
    }

    case "list_commits": {
      const { owner, repo, sha, path } = args;
      const qs = new URLSearchParams({ per_page: "30" });
      if (sha) qs.set("sha", sha);
      if (path) qs.set("path", path);
      const data = await gh(env, `/repos/${owner}/${repo}/commits?${qs.toString()}`);
      if (!data.length) return "(no commits)";
      return data
        .map((c) => `${c.sha.slice(0, 7)} ${c.commit.message.split("\n")[0]} — ${c.commit.author.name}, ${c.commit.author.date}`)
        .join("\n");
    }

    case "get_commit": {
      const { owner, repo, ref } = args;
      const c = await gh(env, `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`);
      let out = `${c.sha}\n${c.commit.author.name} <${c.commit.author.email}>, ${c.commit.author.date}\n\n${c.commit.message}`;
      out += `\n\nStats: +${c.stats.additions}/-${c.stats.deletions} across ${c.files.length} file(s)\n`;
      out += c.files.map((f) => `${f.status} ${f.filename} (+${f.additions}/-${f.deletions})`).join("\n");
      return out;
    }

    case "search_code": {
      const { query, owner, repo } = args;
      let q = query;
      if (owner && repo) q = `repo:${owner}/${repo} ${q}`;
      const data = await gh(env, `/search/code?q=${encodeURIComponent(q)}&per_page=30`);
      if (!data.items || !data.items.length) return "(no matches)";
      return `${data.total_count} match(es):\n` + data.items.map((i) => `${i.repository.full_name}: ${i.path}`).join("\n");
    }

    case "search_issues": {
      const { query } = args;
      const data = await gh(env, `/search/issues?q=${encodeURIComponent(query)}&per_page=30`);
      if (!data.items || !data.items.length) return "(no matches)";
      return `${data.total_count} match(es):\n` + data.items.map((i) => `#${i.number} [${i.state}] ${i.title} — ${i.html_url}`).join("\n");
    }

    case "list_workflows": {
      const { owner, repo } = args;
      const data = await gh(env, `/repos/${owner}/${repo}/actions/workflows?per_page=100`);
      const workflows = data.workflows || [];
      if (!workflows.length) return "(no workflows)";
      return (
        `${workflows.length} workflow(s) in ${owner}/${repo}:\n` +
        workflows.map((w) => `${w.id} ${w.name} [${w.state}] — ${w.path}`).join("\n")
      );
    }

    case "list_workflow_runs": {
      const { owner, repo, workflow_id, branch, event, status, created, include_timing = false } = args;
      const perPage = Math.min(Math.max(Number(args.per_page) || 20, 1), 100);
      const qs = new URLSearchParams({ per_page: String(perPage) });
      if (branch) qs.set("branch", branch);
      if (event) qs.set("event", event);
      if (status) qs.set("status", status);
      if (created) qs.set("created", created);
      const base = workflow_id
        ? `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow_id)}/runs`
        : `/repos/${owner}/${repo}/actions/runs`;
      let data;
      try {
        data = await gh(env, `${base}?${qs.toString()}`);
      } catch (err) {
        if (workflow_id && err.status === 404) {
          throw new Error(
            `No workflow '${workflow_id}' in ${owner}/${repo} — call list_workflows for the exact file names and ids.`,
          );
        }
        throw err;
      }
      const runs = data.workflow_runs || [];
      if (!runs.length) return "(no workflow runs matched)";

      const grandTotals = {};
      const perWorkflow = new Map();
      let timedRuns = 0;
      let wallClockMs = 0;
      let finishedCount = 0;

      const lines = [];
      for (const r of runs) {
        const started = r.run_started_at || r.created_at;
        const elapsed = r.status === "completed" ? new Date(r.updated_at) - new Date(started) : null;
        if (elapsed !== null) {
          wallClockMs += elapsed;
          finishedCount++;
        }
        let line =
          `#${r.run_number} run ${r.id} ${r.name} [${r.status}${r.conclusion ? `/${r.conclusion}` : ""}] ` +
          `${r.event} on ${r.head_branch} — ${started} — ${elapsed === null ? "(still running)" : formatDuration(elapsed)}`;
        if (include_timing && timedRuns < TIMING_MAX_RUNS) {
          timedRuns++;
          try {
            const t = await runBillableMinutes(env, owner, repo, r.id);
            addByOs(grandTotals, t.byOs);
            // Key on the workflow file, not the run name: Dependabot and other
            // dynamic workflows give every run a different name.
            const wfKey = r.path || r.name;
            const wf = perWorkflow.get(wfKey) || { runs: 0, byOs: {} };
            wf.runs++;
            addByOs(wf.byOs, t.byOs);
            perWorkflow.set(wfKey, wf);
            line +=
              `\n    ${t.jobs} job(s), machine time ${formatDuration(t.machineMs)}, ` +
              `~${sumByOs(t.byOs)} billable min (${formatByOs(t.byOs)})` +
              (t.truncated ? " [only the first 100 jobs counted]" : "");
          } catch (err) {
            line += `\n    billable: (unavailable — ${err.message})`;
          }
        }
        lines.push(line);
      }

      let out = `${runs.length} run(s) of ${data.total_count} total match(es) in ${owner}/${repo}:\n` + lines.join("\n");
      if (finishedCount) {
        out +=
          `\n\nWall-clock across the ${finishedCount} completed run(s): ${formatDuration(wallClockMs)} ` +
          `(avg ${formatDuration(wallClockMs / finishedCount)}). Wall-clock is start-to-finish elapsed time, not what you are billed — ` +
          `a run with parallel jobs bills more than its wall-clock.`;
      }
      if (include_timing) {
        out += `\n\nEstimated billable minutes across the ${timedRuns} timed run(s): ${sumByOs(grandTotals)} (${formatByOs(grandTotals)}).`;
        if (perWorkflow.size > 1) {
          out +=
            `\n\nBy workflow:\n` +
            [...perWorkflow.entries()]
              .sort((a, b) => sumByOs(b[1].byOs) - sumByOs(a[1].byOs))
              .map(([wfName, v]) => `  ${wfName}  ${sumByOs(v.byOs)} min across ${v.runs} run(s)  (${formatByOs(v.byOs)})`)
              .join("\n");
        }
        if (runs.length > TIMING_MAX_RUNS) {
          out +=
            `\n\nOnly the first ${TIMING_MAX_RUNS} of ${runs.length} listed runs were timed (one extra API call each, and the Worker has a ` +
            `per-request subrequest budget) — narrow the filters or lower per_page to cover them all.`;
        }
        out +=
          `\n\nMinutes are derived from each job's start/finish time rounded up to a whole minute, which is how GitHub bills. ` +
          `They are raw minutes: against your included allowance, macOS counts 10x and Windows 2x. ` +
          `(The /timing endpoint is not used — it reports 0 ms on accounts moved to enhanced billing.)`;
      }
      return out;
    }

    case "get_actions_billing": {
      const { account_type = "user", year, month, product = "actions" } = args;
      let account = args.account;
      if (!account) {
        if (account_type === "org") throw new Error("account is required when account_type='org'.");
        const me = await gh(env, `/user`);
        account = me.login;
      }

      const period = new URLSearchParams();
      if (year) period.set("year", String(year));
      if (month) period.set("month", String(month));
      const periodQs = period.toString() ? `?${period.toString()}` : "";
      const enhancedPath =
        account_type === "org"
          ? `/organizations/${encodeURIComponent(account)}/settings/billing/usage${periodQs}`
          : `/users/${encodeURIComponent(account)}/settings/billing/usage${periodQs}`;

      let enhancedErr;
      try {
        const usage = await gh(env, enhancedPath);
        let items = usage.usageItems || [];
        if (product !== "all") {
          items = items.filter((i) => String(i.product || "").toLowerCase() === product.toLowerCase());
        }
        if (!items.length) {
          return `Enhanced billing usage — ${account_type} ${account}${periodQs ? ` (${periodQs.slice(1)})` : " (current period)"}: no ${product} usage items reported.`;
        }
        const sum = (rows, key) => rows.reduce((t, r) => t + (Number(r[key]) || 0), 0);
        const money = (n) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;
        const round2 = (n) => Math.round(n * 100) / 100;
        // Line items mix unit types (Actions minutes and Actions storage
        // gigabyte-hours land under the same product), so quantities are only
        // ever summed within a unit type — never across them.
        const groupBy = (rows, key) => {
          const map = new Map();
          for (const r of rows) {
            const k = r[key] || "(none)";
            const cur = map.get(k) || { net: 0, units: new Map() };
            cur.net += Number(r.netAmount) || 0;
            const unit = r.unitType || "units";
            cur.units.set(unit, (cur.units.get(unit) || 0) + (Number(r.quantity) || 0));
            map.set(k, cur);
          }
          return [...map.entries()].sort((a, b) => b[1].net - a[1].net || b[1].units.size - a[1].units.size);
        };
        const renderGroups = (groups) =>
          groups
            .map(([k, v]) => {
              const units = [...v.units.entries()].filter(([, q]) => round2(q) !== 0);
              const qty = (units.length ? units : [...v.units.entries()]).map(([u, q]) => `${round2(q)} ${u}`).join(" + ");
              return `  ${k}  ${qty}  ${money(v.net)}`;
            })
            .join("\n");
        const totalsByUnit = new Map();
        for (const i of items) {
          const u = i.unitType || "units";
          totalsByUnit.set(u, (totalsByUnit.get(u) || 0) + (Number(i.quantity) || 0));
        }

        let out =
          `Enhanced billing usage — ${account_type} ${account}${periodQs ? ` (${periodQs.slice(1)})` : " (current billing period)"}` +
          `, product filter: ${product}\n` +
          `Total: ${[...totalsByUnit.entries()].map(([u, q]) => `${round2(q)} ${u}`).join(", ")}, ` +
          `${money(sum(items, "netAmount"))} net (${money(sum(items, "grossAmount"))} gross - ${money(sum(items, "discountAmount"))} discount) ` +
          `across ${items.length} line item(s)\n`;
        out += `\nBy repository:\n` + renderGroups(groupBy(items, "repositoryName"));
        out += `\n\nBy SKU:\n` + renderGroups(groupBy(items, "sku"));
        return out;
      } catch (err) {
        enhancedErr = err;
      }

      // Not on the enhanced billing platform (or no permission for it) — try
      // the legacy per-product summary, which reports minutes but no per-repo split.
      const legacyPath =
        account_type === "org"
          ? `/orgs/${encodeURIComponent(account)}/settings/billing/actions`
          : `/users/${encodeURIComponent(account)}/settings/billing/actions`;
      try {
        const b = await gh(env, legacyPath);
        const bd = b.minutes_used_breakdown || {};
        const breakdown = Object.entries(bd)
          .filter(([k]) => k !== "total")
          .map(([k, v]) => `${k} ${v}`)
          .join(", ");
        return (
          `Actions minutes (legacy billing summary) — ${account_type} ${account}\n` +
          `Used: ${b.total_minutes_used} min of ${b.included_minutes} included; paid overage: ${b.total_paid_minutes_used} min\n` +
          `Per-runner breakdown: ${breakdown || "(none reported)"}\n\n` +
          `(No per-repository split available here — that comes from the enhanced billing platform, which returned: ${enhancedErr.message}.)`
        );
      } catch (legacyErr) {
        throw new Error(
          `Could not read Actions billing for ${account_type} ${account}. ` +
            `Enhanced endpoint (${enhancedPath}): ${enhancedErr.message}. ` +
            `Legacy endpoint (${legacyPath}): ${legacyErr.message}. ` +
            `Two common causes: the PAT lacks billing read access (fine-grained tokens need the account "Plan" read permission for a user, ` +
            `or organization billing read for an org; classic tokens need 'user' or 'read:org' plus 'manage_billing:organization'), ` +
            `or the account is a personal account rather than an organization — in that case call this without account_type='org'.`,
        );
      }
    }

    case "get_project": {
      const { owner, number } = args;
      const p = await getProjectV2(env, owner, number);
      const fields = p.fields
        .map((f) => {
          const opts = f.options ? `: ${f.options.map((o) => o.name).join(" | ")}` : "";
          return `- ${f.name} (${f.dataType.toLowerCase()})${opts}`;
        })
        .join("\n");
      return (
        `${p.title}${p.closed ? " [closed]" : ""}\n${p.url}\n` +
        (p.shortDescription ? `${p.shortDescription}\n` : "") +
        `\nFields:\n${fields}`
      );
    }

    case "list_project_items": {
      const { owner, number, after, include_archived = false } = args;
      const first = Math.min(Math.max(Number(args.first) || 50, 1), 100);
      const p = await getProjectV2(env, owner, number);
      const query = `
        query($id:ID!,$first:Int!,$after:String){
          node(id:$id){ ... on ProjectV2 {
            items(first:$first, after:$after){
              totalCount
              pageInfo { hasNextPage endCursor }
              nodes {
                id type isArchived
                content {
                  ... on Issue { number title state repository { nameWithOwner } }
                  ... on PullRequest { number title state repository { nameWithOwner } }
                  ... on DraftIssue { title }
                }
                fieldValues(first:30){ nodes {
                  ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
                  ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } }
                  ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } }
                  ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
                  ... on ProjectV2ItemFieldIterationValue { title field { ... on ProjectV2FieldCommon { name } } }
                } }
              }
            }
          } }
        }`;
      const data = await ghGraphQL(env, query, { id: p.id, first, after: after || null });
      const items = data.node.items;
      const shown = items.nodes.filter((it) => include_archived || !it.isArchived);
      const hidden = items.nodes.length - shown.length;
      let out = `${p.title} — ${items.totalCount} item(s)\n\n`;
      out += shown.length ? shown.map(formatProjectItem).join("\n") : "(no items on this page)";
      if (hidden) out += `\n\n(${hidden} archived item(s) on this page hidden; pass include_archived to show)`;
      if (items.pageInfo.hasNextPage) out += `\n\nMore items: pass after="${items.pageInfo.endCursor}"`;
      return out;
    }

    case "add_project_item": {
      const { owner, number, content_repo, content_number, draft_title, draft_body, fields } = args;
      const content_owner = args.content_owner || owner;
      if (!(content_repo && content_number) && !draft_title) {
        throw new Error("Pass content_repo + content_number to add an issue/PR, or draft_title for a draft item");
      }
      const p = await getProjectV2(env, owner, number);
      let itemId;
      let what;
      if (content_repo && content_number) {
        const q = `
          query($owner:String!,$repo:String!,$number:Int!){
            repository(owner:$owner,name:$repo){
              issueOrPullRequest(number:$number){ ... on Issue { id } ... on PullRequest { id } }
            }
          }`;
        const d = await ghGraphQL(env, q, { owner: content_owner, repo: content_repo, number: content_number });
        const node = d && d.repository && d.repository.issueOrPullRequest;
        if (!node) throw new Error(`#${content_number} not found in ${content_owner}/${content_repo}`);
        const m = `
          mutation($p:ID!,$c:ID!){
            addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item { id } }
          }`;
        const r = await ghGraphQL(env, m, { p: p.id, c: node.id });
        itemId = r.addProjectV2ItemById.item.id;
        what = `${content_owner}/${content_repo}#${content_number}`;
      } else if (draft_title) {
        const m = `
          mutation($p:ID!,$t:String!,$b:String){
            addProjectV2DraftIssue(input:{projectId:$p,title:$t,body:$b}){ projectItem { id } }
          }`;
        const r = await ghGraphQL(env, m, { p: p.id, t: draft_title, b: draft_body || null });
        itemId = r.addProjectV2DraftIssue.projectItem.id;
        what = `draft "${draft_title}"`;
      }
      const set = await setProjectItemFields(env, p, itemId, fields);
      return `Added ${what} to ${p.title} as item ${itemId}` + (set.length ? `\nSet: ${set.join(", ")}` : "");
    }

    case "update_project_item_field": {
      const { owner, number, item_id, fields } = args;
      if (!fields || !Object.keys(fields).length) throw new Error("fields is empty — nothing to update");
      const p = await getProjectV2(env, owner, number);
      const set = await setProjectItemFields(env, p, item_id, fields);
      return `Updated ${item_id} in ${p.title}: ${set.join(", ")}`;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleRpc(msg, env) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    return jsonRpcResult(id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "gh-mcp", version: "1.0.0" },
    });
  }

  if (method === "notifications/initialized") {
    return null; // notification, no response
  }

  if (method === "tools/list") {
    return jsonRpcResult(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    try {
      // Tools return either a plain string or {content: [...]} when they need
      // richer blocks (e.g. get_file returning an inline image).
      const out = await callTool(name, args || {}, env);
      const content =
        out && typeof out === "object" && Array.isArray(out.content)
          ? out.content
          : [{ type: "text", text: String(out) }];
      return jsonRpcResult(id, { content });
    } catch (err) {
      return jsonRpcResult(id, {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      });
    }
  }

  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

// Constant-time comparison of the URL token against MCP_TOKEN. Both sides are
// hashed first so the comparison is always over equal-length buffers and the
// token's length doesn't leak through timing either.
async function tokenMatches(given, expected) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // ["mcp", "<token>"]

    if (parts[0] !== "mcp" || !parts[1]) {
      return new Response("Not found", { status: 404 });
    }
    if (!env.MCP_TOKEN || !(await tokenMatches(parts[1], env.MCP_TOKEN))) {
      return new Response("Not found", { status: 404 }); // 404, not 401 — don't confirm the path exists
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const messages = Array.isArray(body) ? body : [body];
    const responses = [];
    for (const msg of messages) {
      const result = await handleRpc(msg, env);
      if (result) responses.push(result);
    }

    if (responses.length === 0) {
      return new Response(null, { status: 202 }); // notification only
    }

    const payload = Array.isArray(body) ? responses : responses[0];
    return new Response(JSON.stringify(payload), {
      headers: { "Content-Type": "application/json" },
    });
  },
};
