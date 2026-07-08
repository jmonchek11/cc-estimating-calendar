# "Sign in with Microsoft" — Implementation Spec (Estimating Calendar)

*Authored 2026-07-08 by the platform-planning session. Context: this is Phase 1 of the
multi-app SSO plan in `../../PLATFORM_ROADMAP.md` (one folder up from the repo root).
This spec is self-contained — everything needed to implement is below.*

## Goal

Add Microsoft Entra ID (OIDC) sign-in alongside the existing email/password login.
Employees click "Sign in with Microsoft", authenticate with their `@libertyintegrated.com`
account, and land in the app with a normal session. Password login stays as a fallback
for now (retirement is a later, separate step after 1–2 weeks of stable use).

## Entra app registration (ALREADY DONE — do not create)

- Registration name: **Liberty Internal Apps**, single-tenant.
- Web platform redirect URIs already registered:
  - `https://lis-estimating-calendar.onrender.com/auth/callback`
  - `http://localhost:3000/auth/callback`
- Admin consent granted for Microsoft Graph `User.Read`.
- Joe (jmonchek) holds the three values. **Never commit them.** They arrive as env vars:

```
AZURE_TENANT_ID=...
AZURE_CLIENT_ID=...
AZURE_CLIENT_SECRET=...
```

Joe must add these in the Render dashboard (and to local `app/.env` for dev testing).

## Current auth architecture (verified 2026-07-08, don't rediscover)

- `server.js:17-27` — `express-session` + `connect-mongo` store, 8h TTL,
  `SESSION_SECRET` env var. A logged-in user is simply `req.session.userId = <TeamMember id>`.
- `server.js:39-45` — auth middleware protects `/api/*` except prefixes in
  `PUBLIC_API = ['/api/auth/', '/api/team', '/api/tv/']`. Non-API routes are NOT
  session-gated server-side (the SPA shows a login overlay client-side).
- `server.js:142-150` — `POST /api/auth/login` calls `db.loginUser(email, password)`
  (bcrypt, in `db.js:188`), then sets `req.session.userId = member.id`.
- `models/TeamMember.js` — has `email` (lowercase, trimmed, unique sparse index),
  `is_admin`, `must_change_password`. Integer `_id`.
- **v2/v1 split**: `/` serves `public/v2.html` (the current app); v1 is at `/legacy`
  (`public/index.html`). **Login UI currently lives ONLY on the v1 page** — v2 redirects
  to `/legacy` to log in (see comments at `public/v2.html:265` and `:2987`), then returns.
  The password-login overlay markup is at `public/index.html:18-31` (`#login-overlay`).

## Implementation

### 1. Dependency

`npm install @azure/msal-node` (in `app/`). Use `ConfidentialClientApplication` —
server-side auth-code flow. Do not use passport or deprecated `passport-azure-ad`.

### 2. New module: `app/msauth.js`

- Export `isConfigured()` → true only if all three AZURE_* env vars are set.
  **Everything below must no-op gracefully when not configured** (deploy happens
  before Joe sets Render env vars — the app must not crash and the button must hide).
- Build MSAL config: authority `https://login.microsoftonline.com/${AZURE_TENANT_ID}`,
  clientId, clientSecret.
- Redirect URI: derive from env — `process.env.MS_REDIRECT_URI ||
  (production ? 'https://lis-estimating-calendar.onrender.com/auth/callback'
              : 'http://localhost:3000/auth/callback')`.
  (Check what port `server.js` actually listens on for the localhost default.)

### 3. Routes (in `server.js`, near existing auth routes)

- `GET /auth/login`
  - If not configured → redirect `/legacy?sso=unavailable`.
  - Generate a random `state` (crypto), store in `req.session.msAuthState`.
  - `getAuthCodeUrl({ scopes: ['user.read'], redirectUri, state })` → redirect user there.
- `GET /auth/callback`
  - Verify `req.query.state === req.session.msAuthState` (then delete it); on mismatch → 403.
  - `acquireTokenByCode({ code, scopes: ['user.read'], redirectUri })`.
  - From `response.account` / ID token claims take: `oid` (stable Microsoft user id),
    `preferred_username` (the email), `name`.
  - **Match to TeamMember** (see §4). On success: `req.session.userId = member.id`,
    also clear `must_change_password` requirement path is NOT triggered (SSO users
    don't need a password), then redirect `/` .
  - No match → redirect `/legacy?sso=nomatch` (v1 login page shows a friendly error, §5).
  - Wrap in try/catch → redirect `/legacy?sso=error` on failure, log details server-side.
- Note: these are top-level routes (not `/api/...`), so the API auth middleware
  doesn't apply. No changes needed to `PUBLIC_API`.

### 4. Matching logic (in `db.js`, new function `loginWithMicrosoft({ oid, email, name })`)

1. Normalize email to lowercase/trim (schema does this on save, do it for the query too).
2. First try `TeamMember.findOne({ ms_oid: oid })` — durable link, survives email changes.
3. Else `TeamMember.findOne({ email, active: 1 })`. If found, set `ms_oid = oid` on it
   (first-login linking) and save.
4. Return the member (formatted like `getMember` does) or `null`.
5. **Do NOT auto-create TeamMembers.** Unknown Microsoft accounts get the
   "no match" page — admins add people via the existing Team page first.

Schema change in `models/TeamMember.js`: add
`ms_oid: { type: String, default: null, index: { unique: true, sparse: true } }`.

⚠️ Per project convention: update `docs/DATA_MODEL_SPEC.md` with the new
`ms_oid` field in the same commit (standing rule for schema changes).

### 5. UI — v1 login page (`public/index.html` `#login-overlay`)

Above the email field, add:
- A "Sign in with Microsoft" button → plain `<a href="/auth/login">` styled as a button.
  Use Microsoft's brand look: white/dark button with the 4-square Microsoft logo
  (inline SVG, 4 colored rects: #F25022 #7FBA00 #00A4EF #FFB900) and the exact text
  "Sign in with Microsoft" (their branding guideline wording).
- An "— or —" divider between it and the existing email/password form.
- On page load (in the existing login JS in `public/app.js`), read `?sso=` param:
  - `nomatch` → show in `#login-error`: "Your Microsoft account isn't linked to a
    team member yet. Ask an admin to add your email on the Team page, then try again."
  - `error` → "Microsoft sign-in failed. Try again or use your password."
  - `unavailable` → "Microsoft sign-in isn't set up on this server yet."
- Hide the Microsoft button when SSO isn't configured: add `GET /api/auth/sso-status`
  → `{ enabled: msauth.isConfigured() }` (it's under `/api/auth/` so already public),
  and only show the button when enabled.

v2 page needs **no login changes** (it already bounces to `/legacy` for login), but
verify the post-login redirect still lands on `/` (v2) — callback should redirect `/`.

### 6. Logout

Existing `POST /api/auth/logout` just destroys the session — fine as-is. Do NOT add
Microsoft single-logout (logging the user out of Microsoft everywhere would log them
out of Outlook etc. — wrong behavior for an internal tool).

## Rollout order (important)

1. Implement + test locally with the three values in `app/.env` (localhost redirect
   URI is already registered). Verify: happy path, unknown-email path, state mismatch.
2. Commit + push (auto-deploys to Render). Safe: without env vars the button hides
   and routes no-op.
3. Joe adds the three AZURE_* env vars in Render → redeploy.
4. Joe tests with his own account, then confirms 2–3 teammates' emails in the Team
   page match their Microsoft emails exactly.
5. Announce to the team. Password login stays until a later decision.

## Testing checklist

- [ ] Fresh browser → `/` → bounced to `/legacy` → Microsoft button visible → full
      sign-in → lands on v2 `/` logged in (check `/api/auth/me` returns the member).
- [ ] Microsoft account whose email matches no TeamMember → friendly `nomatch` message,
      NOT a crash or a hung redirect loop.
- [ ] `ms_oid` gets stamped on the TeamMember after first SSO login (check DB).
- [ ] Second login for same user matches via `ms_oid` even if you change their
      TeamMember email.
- [ ] Password login still works unchanged; `must_change_password` flow unaffected.
- [ ] With AZURE_* env vars absent: server boots clean, button hidden, `/auth/login`
      redirects with `sso=unavailable`.
- [ ] Inactive member (`active: 0`) cannot log in via SSO.

## Out of scope for this task

- No shared `liberty-core` users collection yet (later platform phase).
- No changes to the manpower board or PC tool.
- No password-login removal.
- No role changes — `is_admin` and `role` continue to come from the TeamMember record.
