/**
 * OAuth sign-in for the MCP endpoint ("Sign in with GitHub").
 *
 * This Worker is the OAuth authorization server for MCP clients (via
 * @cloudflare/workers-oauth-provider), and GitHub is only the identity step:
 * the user signs in with GitHub so we learn their login, and that login must
 * be on ALLOWED_GITHUB_USERS. GitHub API calls still use the deployment's own
 * GITHUB_TOKEN; the user's GitHub sign-in token is used once to read their
 * login and then discarded, so it asks GitHub for no scopes at all.
 *
 * Flow: client -> GET /authorize (our consent page) -> POST /authorize ->
 * github.com/login/oauth/authorize -> GET /callback -> back to the client
 * with a code -> client exchanges it at /oauth/token -> Bearer on /mcp.
 *
 * Needs: OAUTH_KV (KV binding), GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
 * (a GitHub OAuth app whose callback URL is https://<worker>/callback), and
 * ALLOWED_GITHUB_USERS (comma-separated logins). Fails closed: with no
 * allowlist, nobody can sign in.
 */

import {
  OAuthProvider,
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
} from "@cloudflare/workers-oauth-provider";

export const MCP_PATH = "/mcp";
const AUTHORIZE_PATH = "/authorize";
const CALLBACK_PATH = "/callback";

export function oauthConfigured(env) {
  return Boolean(env.OAUTH_KV && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && allowedUsers(env).length);
}

function allowedUsers(env) {
  return (env.ALLOWED_GITHUB_USERS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowedUser(env, login) {
  return Boolean(login) && allowedUsers(env).includes(String(login).toLowerCase());
}

// The provider's canonical resource must be this Worker's own URL, which
// isn't known until a request arrives, so build one per origin and keep it.
const providers = new Map();

export function oauthProvider(origin, handleMcp) {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider({
      apiRoute: MCP_PATH,
      apiHandler: {
        async fetch(request, env, ctx) {
          // Re-checked on every call, so removing someone from the allowlist
          // cuts them off immediately rather than when their token expires.
          if (!isAllowedUser(env, ctx.props?.login)) {
            return new Response("Forbidden: this GitHub account is not on ALLOWED_GITHUB_USERS", { status: 403 });
          }
          return handleMcp(request, env);
        },
      },
      defaultHandler: { fetch: handleAuthPages },
      authorizeEndpoint: AUTHORIZE_PATH,
      tokenEndpoint: "/oauth/token",
      // Claude and most MCP clients register themselves (DCR); newer ones
      // identify with a metadata document URL (CIMD). Both are accepted;
      // the consent page is what stops a stranger's client riding on a
      // signed-in user.
      clientRegistrationEndpoint: "/oauth/register",
      clientIdMetadataDocumentEnabled: true,
      resourceMetadata: {
        resource: origin + MCP_PATH,
        authorization_servers: [origin],
        resource_name: "gh-mcp",
      },
    });
    providers.set(origin, provider);
  }
  return provider;
}

// --- /authorize and /callback ----------------------------------------------

async function handleAuthPages(request, env) {
  const url = new URL(request.url);
  try {
    if (url.pathname === AUTHORIZE_PATH && request.method === "GET") return await showConsent(request, env);
    if (url.pathname === AUTHORIZE_PATH && request.method === "POST") return await submitConsent(request, env);
    if (url.pathname === CALLBACK_PATH && request.method === "GET") return await githubCallback(request, env);
  } catch (err) {
    if (err instanceof AuthorizationError && err.redirectTo) {
      return Response.redirect(err.redirectTo, 302);
    }
    if (err instanceof AuthorizationError || err instanceof CimdFetchError) {
      const message =
        err instanceof AuthorizationError ? err.description : "This app could not be verified.";
      return page("Sign-in failed", `<p>${escape(message || "The request was not valid.")}</p>
<p>Start again from your MCP client.</p>`, 400);
    }
    throw err;
  }
  return new Response("Not found", { status: 404 });
}

async function showConsent(request, env) {
  const oauth = env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authRequest); // before beginConsent: a failed lookup leaves nothing in KV
  const consent = await oauth.beginConsent(authRequest);
  consent.headers.set("Content-Type", "text/html; charset=utf-8");

  const name = escape(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : "This app registered itself, so its name is not verified.";
  const body = `<p><strong>${name}</strong> wants to use this GitHub MCP server, which can read and change
GitHub repositories with this server's token.</p>
<p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${
  details.redirectIsLoopback
    ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>"
    : ""
}
<p>If you didn't just add this server to an app, choose Deny.</p>
<p>You'll sign in with GitHub next. Only accounts this server's owner has allowed can finish.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escape(consent.handle)}">
  <button name="decision" value="approve">Continue with GitHub</button>
  <button name="decision" value="deny">Deny</button>
</form>`;
  return new Response(html(`Allow ${name}?`, body), { headers: consent.headers });
}

async function submitConsent(request, env) {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get("handle") || "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(request, handle);

  // PKCE against GitHub too, so an intercepted GitHub code is useless.
  const verifier = randomString(32);
  const { state, headers } = await oauth.beginUpstream(approved.request, {
    data: { verifier },
    headers: approved.headers,
  });
  const github = new URL("https://github.com/login/oauth/authorize");
  github.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  github.searchParams.set("redirect_uri", new URL(CALLBACK_PATH, request.url).href);
  github.searchParams.set("state", state);
  github.searchParams.set("scope", ""); // identity only: we just need the login
  github.searchParams.set("allow_signup", "false");
  github.searchParams.set("code_challenge", await s256(verifier));
  github.searchParams.set("code_challenge_method", "S256");
  headers.set("Location", github.href);
  return new Response(null, { status: 302, headers });
}

async function githubCallback(request, env) {
  const oauth = env.OAUTH_PROVIDER;
  const url = new URL(request.url);
  const { request: original, data, headers } = await oauth.finishUpstream(request);

  const deny = (description) => {
    headers.set("Location", authorizationErrorRedirect(original, "access_denied", description));
    return new Response(null, { status: 302, headers });
  };
  if (url.searchParams.get("error")) return deny("GitHub sign-in was cancelled or failed");

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code: url.searchParams.get("code"),
      redirect_uri: new URL(CALLBACK_PATH, request.url).href,
      code_verifier: data.verifier,
    }),
  });
  const token = await tokenRes.json().catch(() => ({}));
  if (!token.access_token) return deny("GitHub sign-in could not be completed");

  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "gh-mcp",
    },
  });
  const user = await userRes.json().catch(() => ({}));
  if (!userRes.ok || !user.login) return deny("Could not read the GitHub account");

  if (!isAllowedUser(env, user.login)) {
    return deny(`GitHub account ${user.login} is not allowed on this server`);
  }

  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: String(user.id),
    metadata: { login: user.login },
    scope: original.scope,
    props: { login: user.login, githubId: user.id },
  });
  headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers });
}

// --- helpers ------------------------------------------------------------------

function escape(value) {
  return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function html(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1rem; color: #1f2328; background: #fff; }
  @media (prefers-color-scheme: dark) { body { color: #e6edf3; background: #0d1117; } }
  button { font: inherit; padding: .5rem 1rem; margin-right: .5rem; cursor: pointer; }
</style></head>
<body><h1>${title}</h1>${body}</body></html>`;
}

function page(title, body, status) {
  return new Response(html(escape(title), body), {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
    },
  });
}

function randomString(bytes) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return base64url(buf);
}

async function s256(input) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return base64url(new Uint8Array(digest));
}

function base64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
