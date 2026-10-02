# MANAGE Alumni Association — Online Voting Platform

A full-stack election system for the **MANAGE Alumni Association** (National Institute of Agricultural Extension Management, Hyderabad).

- **Voter portal** (`/`): enter personal voting code → ballot → review → submit once → confirmation with live turnout. No accounts, mobile-first.
- **Admin dashboard** (`/admin`): election settings and status, positions, candidates (with photos), voter register and import, voting codes, email invitations, turnout, voting records, audit log, results, exports and publication, admin users and permissions.

Stack: Node.js (≥ 18.18) · Express · SQLite (better-sqlite3) · server-rendered EJS · Nodemailer. No build step.

## Quick start

```bash
npm install
npm run seed:demo        # optional: clearly-labelled DEMO election with sample data
npm start                # http://localhost:3000
```

On first start without demo data, a Main Administrator account is created and its password is printed once in the console (or set `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD`). Further admins can be created in **Admin → Admin users**, or with `npm run create-admin -- <username> "<Full Name>" [password]`.

Copy `.env.example` to `.env` to configure the public URL, HTTPS cookies and SMTP.

### Demo data

`npm run seed:demo` creates the election *"MANAGE Alumni Association Election 2026 (Demo)"* (open, 60 voters, 28 ballots already cast, a mix of invitation statuses, an unopposed Treasurer, a withdrawn candidate, duplicates and missing-email voters to review). Every page shows a **DEMO** banner for it. The command prints demo admin logins (`demo.admin / DemoAdmin2026`, `demo.officer`, `demo.manager`, `demo.auditor`) and several unused voting codes you can vote with.
`npm run seed:demo -- --closed` creates it already closed, to try results review and publication. Re-running replaces only demo data; real elections are never touched.

## Election workflow

1. **Election settings** — name, term, description, opening/closing time (IST), support contact.
2. **Positions** — add, rename, reorder, remove; mark *contested* or *unopposed* (choose the declared winner).
3. **Candidates** — name, photo, batch, position, order; status Draft / Approved / Withdrawn. Only approved candidates appear on the ballot.
4. **Voters** — import CSV/XLSX (preview with duplicate, missing and invalid data flagged) or add manually; review eligibility; **approve the final voter list**.
5. **Voting codes** — generate one code per eligible voter (format `K7NP-4XQM-9TWR-H6CJ`). Revoke / replace unused codes; copy or export codes for voters without email.
6. **Invitations** — edit the template, preview, **Send Invitations** → confirmation (“You are about to send voting invitations to N eligible voters”) → **Confirm and Send**. Retry failures, resend to selected voters.
7. **Mark ready → Open voting** (or schedule automatic opening). Ballot configuration locks once voting opens.
8. Monitor **Turnout**, **Voting records** and the **Audit log**; authorised admins can **View vote** for any voter.
9. **Close election** → **Results** (reconciliation and tie detection) → **Export** → **Publish Results**. The public `/results` page appears only after publication.

Election states: Draft → Ready → Scheduled → Open ⇄ Suspended → Closed → Results review → Results published → Archived. Opening and closing also happen automatically at the configured times.

## Integrity guarantees

| Rule | How it is enforced |
|---|---|
| One voter = one entitlement | Partial unique index: at most one `active`/`used` code per voter; DB trigger blocks any new code for a voter who has voted. |
| One entitlement = max one ballot | Submission runs in a single write-locked (`BEGIN IMMEDIATE`) transaction that re-checks the code; `UNIQUE(voter_id)` and `UNIQUE(code_id)` on ballots as a backstop. |
| Double click / refresh / lost response | Each ballot session has a submission token; a replay of an accepted submission returns the same confirmation instead of an error. Submit buttons disable after the first click. |
| Multiple tabs/devices | Only the first submission commits; the rest see “A ballot has already been submitted using this code.” (covered by an automated concurrency test). |
| Complete ballots only | Server validates one candidate or abstain for every contested post; ballot and choices are written atomically. |
| Ballots are locked | DB triggers reject UPDATE/DELETE on ballots and choices and reverting a used code; no admin screen offers these actions. |
| Voting only while open | Checked at code entry and again inside the submission transaction. |
| Candidate totals hidden during voting | Results are unavailable to everyone until the election is closed; the public API exposes only turnout. |
| Sensitive access is controlled and logged | `View individual votes` / `Export individual votes` permissions; every ballot view, export and code reveal is written to the append-only audit log (DB triggers block edits). |
| Turnout | Accepted ballots ÷ eligible voters on the approved register. |

Voting codes come from a CSPRNG over a 31-character unambiguous alphabet (≈ 7.6 × 10²³ possibilities), and code entry is rate-limited per IP. Admin passwords use scrypt; sessions are server-side with HttpOnly SameSite cookies; all forms are CSRF-protected; a strict Content-Security-Policy is set; CSV exports are protected against formula injection.

## Roles

| Role | Default permissions |
|---|---|
| Main Administrator | Everything |
| Election Administrator | Election, positions, candidates, voters, codes, invitations, turnout, aggregate results/export, audit log |
| Election Officer | Turnout, aggregate results and export (grant *View/Export individual votes* or *Publish results* explicitly if authorised) |
| Read-only Auditor | Turnout, aggregate results, audit log |

Permissions can be adjusted per user.

## Email

With `SMTP_HOST` set, invitations are sent through SMTP by a background queue (rate-limited by `MAIL_RATE_PER_MINUTE`, resumes after restarts). Without SMTP, the platform runs in **outbox mode**: messages are rendered and stored in **Invitations → Email outbox** so personalisation can be checked without sending. Before every send the queue re-checks that the code is still the voter's own active code; failures are marked *Failed* without affecting eligibility or the code.

## Front-end prototype (Vercel)

`prototype/` is a static, front-end-only preview of every screen with dummy data, deployable on Vercel as-is (`vercel.json` serves only that folder; no backend runs). Forms and buttons click through to the next screen, but nothing is saved.

Regenerate it after changing templates or styles:

```bash
npm run build:prototype
```

The pages are rendered from the real templates in `views/` and `public/`, so front-end changes made there apply to both the prototype and the full app.

## Deployment notes

> **Do not deploy on Vercel, Netlify or other serverless platforms.** They have no persistent disk, so the election database would be wiped between requests and votes would be lost. Use a host with a persistent disk/volume and a single always-on process.

- **Render:** *New → Blueprint*, select this repository; `render.yaml` sets up the service and a persistent disk. Set `PUBLIC_BASE_URL`, then read the generated `INITIAL_ADMIN_PASSWORD` under *Environment*.
- **Railway / Fly.io / VPS:** use the `Dockerfile` and attach a persistent volume at `/data`.

- Run behind HTTPS (e.g. nginx or Caddy) with `SECURE_COOKIES=true` and `TRUST_PROXY=true`.
- Run a **single** Node process (the in-process mail queue and rate limiters assume one instance). SQLite in WAL mode handles election-scale load comfortably.
- Back up the `DATA_DIR` directory (database + candidate photos), e.g. with `sqlite3 data/election.db ".backup backup.db"`.

## Tests

```bash
npm test
```

Covers the full admin → voter → results → publication flow, simultaneous submissions from many sessions, invalid/revoked/used codes, resend without new entitlement, database-level ballot locking, permission checks, audit logging of ballot access, and repeat-import de-duplication.
