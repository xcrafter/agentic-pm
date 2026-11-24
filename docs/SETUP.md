# Set up Agentic PM for a company

This guide puts Agentic PM online for one company, on that company's own Cloudflare account. It takes about 20 minutes. You don't need to be a developer. You'll copy a few commands into a terminal and click through the Cloudflare dashboard.

At the end you'll have:

- the app running at an address like `https://agentic-pm.acme.workers.dev`
- automatic updates whenever a new version is released

---

## Before you start

You need four things:

| | What | Why |
|---|---|---|
| ☐ | A **Cloudflare account** for the company, and a login that can manage it | The app runs there. The free plan is enough to start. |
| ☐ | **R2 turned on** in that account (dashboard → **R2** → **Get started**) | R2 stores files people attach to tasks. Turning it on is free to start, but Cloudflare asks you to do it once by hand. |
| ☐ | **Node.js** on your computer (download the "LTS" version from [nodejs.org](https://nodejs.org)) | It runs the setup commands. Install it once, like any app. |
| ☐ | Access to the **agentic-pm repository on GitHub** | You download the code from there. Ask the maintainer to add your GitHub account if you can't open it. |

---

## Part 1: Put the app online (about 10 minutes)

**1. Download the code.** On the repository page on GitHub, click the green **Code** button, then **Download ZIP**. Unzip it somewhere easy to find, for example your Desktop.

**2. Open a terminal in that folder.**
- Mac: open **Terminal**, type `cd ` (with a space), drag the unzipped folder into the window, and press Enter.
- Windows: open the unzipped folder, click the address bar, type `cmd`, and press Enter.

**3. Install the tools the setup needs.** It takes a minute or two:

```
npm install
```

**4. Sign in to Cloudflare.** A browser window opens. Sign in, and click **Allow**:

```
npx wrangler login
```

**5. Do a dry run first.** Replace `Acme` with the company's name, and `acme.com` with the company's email domain (the part after the @ in its email addresses):

```
npm run onboard -- --name "Acme" --domain acme.com --check
```

> **What `--domain` does:** it restricts sign-ups to that domain. Only people with an `@acme.com` email address can join: admins can't invite anyone else, and with Google sign-in, nobody from outside can create an account. For several domains, separate them with commas: `--domain acme.com,acme.co.uk`. An admin can change the list later in the app (**Settings → Allowed email domains**).

This only looks around; it changes nothing. Read what it says:
- If it lists several Cloudflare accounts, copy the `--account …` line for the right company and add it to the end of the command. The account name works too, for example `--account "Acme Inc"`.
- If it says **"Before running for real"**, do what it asks first (usually: turn on R2).

**6. Run it for real.** Use the same command without `--check`:

```
npm run onboard -- --name "Acme" --domain acme.com
```

The setup:
- creates the company's database and storage
- puts the app online
- creates its passwords for internal use (you never need to see them)

When it finishes, **keep the terminal open**: the last part of the output is what you need for Part 2.

> Want your own address, like `tasks.acme.com`, instead of `…workers.dev`? Add `--url https://tasks.acme.com` to the command, and connect that domain to the Worker in Cloudflare (**Workers & Pages → agentic-pm → Settings → Domains & Routes**).

---

## Part 2: Turn on automatic updates (about 5 minutes)

This connects the company's Cloudflare account to the code on GitHub. From then on, every new release installs itself.

> This part needs the **GitHub account that owns the repository** to approve Cloudflare's access once. If that isn't you, do this part together with the maintainer.

1. In the Cloudflare dashboard, open **Workers & Pages**, then **agentic-pm**.
2. Go to **Settings**, scroll to **Build**, and click **Connect**.
3. Choose **GitHub**, approve access if asked, and pick the **agentic-pm** repository.
4. Fill in the four fields exactly as the setup printed them:

   | Field | Value |
   |---|---|
   | Branch | `release` |
   | Build command | `npm run build` |
   | Deploy command | `npm run deploy:ci` |

5. On the same page, find **Build variables and secrets**. Add each line the setup printed under "Build variables", one at a time: the name on the left, the value on the right. There are usually six.

   ⚠️ Use **Build variables and secrets**, under **Build**. Don't use the other section called **Variables and Secrets**: that one is for something else, and these won't work there.

6. Click **Save**. To check it works, open the **Deployments** tab. You'll see a build there after the next release, or you can click **Retry build** on the latest one.

---

## Part 3: Start using it (2 minutes)

1. Open the app's address (the setup printed it). The **first person to visit becomes the admin**, so do this right away.
2. Create your account with your name, work email and a password.
3. Go to **Members & agents → Invite person** to add teammates. Each one gets a sign-up link to send them.

That's it. The rest of the main README covers connecting AI agents (Grok and others) and day-to-day use.

---

## Optional: Email notifications

Without this, the app sends no email: people see what needs them in their Inbox, and admins send invite links themselves. With it, people are emailed when a task is assigned to them, they're @mentioned, an agent asks them something or an agent they started fails, and invite links are emailed automatically. Each person can turn kinds of email off.

You need two things first:

- The Cloudflare account on the **Workers Paid** plan (about $5 a month; includes 3,000 emails a month). The free plan can't email people.
- The company's domain (for example `acme.com`) **using Cloudflare for its DNS**. Emails come from an address on it, like `notifications@acme.com`.

Then:

1. In the Cloudflare dashboard, open **Email Service → Email Sending**, click **Onboard Domain**, and pick the company's domain. Cloudflare adds the DNS records itself; it usually takes a few minutes.
2. Open **Workers & Pages → agentic-pm → Settings → Build → Build variables and secrets** and add `APM_EMAIL_FROM` with the sender address, for example `notifications@acme.com`. (Setting up a new company? Add `--email-from notifications@acme.com` to the onboard command and it prints this variable with the others.)
3. Open **Deployments** and click **Retry build** on the latest one.
4. In the app, go to **Settings → Email** and click **Send me a test email**. If it doesn't arrive, the list below the button shows the error.

---

## Optional: "Sign in with Google"

Without this, people sign in with an email and password, which works fine. To add a Google button:

1. In Google Cloud Console, create an **OAuth client ID** (type: Web application).
2. Add this as an authorized redirect URI: `https://<the app's address>/auth/google/callback`
3. In Cloudflare: **Workers & Pages → agentic-pm → Settings → Variables and Secrets**. Add two **Secrets**, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, with the values from Google.

---

## If something goes wrong

| What you see | What to do |
|---|---|
| `npm: command not found` | Node.js isn't installed, or the terminal was open before you installed it. Install it from nodejs.org and open a new terminal. |
| "Your login can reach several Cloudflare accounts" | Add the `--account …` line it shows for the right company to the end of your command. |
| "R2 (file storage) isn't turned on" | Cloudflare dashboard → **R2** → **Get started**. Then run the command again. |
| "This account has no workers.dev subdomain yet" | Open **Workers & Pages** in the dashboard once; it asks you to choose one. Then run the command again. |
| A build fails with "set these build variables…" | A variable from Part 2, step 5 is missing or misspelled. The message names it. Add it and click **Retry build**. |
| A build fails at the database step with a permission error | On the same **Build** settings page, edit the **API token** and add the permission **D1 → Edit**. |
| You ran a command twice | That's fine. The setup reuses what already exists and doesn't duplicate anything. |

---

<details>
<summary><strong>For the maintainer: how releases and settings work</strong></summary>

**One repository serves every company.** Each company's Cloudflare account builds the `release` branch with its own **build variables**. During the build, `scripts/configure.mjs` writes them into `wrangler.jsonc`; the repository itself only contains placeholders. A build on Cloudflare fails with a clear message if a required variable is missing, so no company is ever deployed with the placeholders.

**Versions:** every push to `main` that passes the checks gets the next version tag and a GitHub release listing its commits (`scripts/next-version.sh`). Each one is a minor version (v1.4.0 → v1.5.0). For a major version (v2.0.0), end the commit message's first line, or a squash-merged PR title, with `#major`, for example "New permissions model #major". A version tag doesn't deploy anything.

**Releasing:** work on `main`, then run `git push origin main:release`. Every connected company builds, applies database migrations (`npm run deploy:ci`), and deploys. To hold one company back, point its Build **Branch** at a different branch. Migrations only add things, and D1 keeps 30 days of point-in-time restore.

**Build variables:**

| Variable | Required | Notes |
|---|---|---|
| `APM_PUBLIC_URL` | yes | The address people use. |
| `APM_ALLOWED_EMAIL_DOMAINS` | yes | Restricts sign-ups to these email domains (comma-separated): invites and Google sign-in accept only these addresses. Admins can change it later in the app, and the app's setting wins. |
| `APM_D1_DATABASE_ID` | yes | |
| `APM_KV_NAMESPACE_ID` | yes | |
| `APM_WORKSPACE_NAME`, `APM_WORKSPACE_KEY` | no | Used only when the workspace is first created. |
| `APM_EMAIL_FROM` | no | Turns on email notifications, sent from this address. Its domain must be onboarded to Email Sending (see "Email notifications"). |
| `APM_WORKER_NAME`, `APM_D1_DATABASE_NAME`, `APM_R2_BUCKET`, `APM_QUEUE` | no | Only if the defaults were renamed. |

**Runtime secrets** (set by `npm run onboard`, or by hand with `wrangler secret put`): `SESSION_SECRET`, `WEBHOOK_KEY_ENCRYPTION_KEY`, and optionally `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. They never live in the repository.

**What `npm run onboard` does, if you'd rather do it by hand:**

```bash
npx wrangler d1 create agentic-pm
npx wrangler kv namespace create agentic-pm-oauth
npx wrangler r2 bucket create agentic-pm-files
npx wrangler queues create agentic-pm-dispatch
# then build and deploy with the build variables set as environment variables:
APM_PUBLIC_URL=… APM_ALLOWED_EMAIL_DOMAINS=… APM_D1_DATABASE_ID=… APM_KV_NAMESPACE_ID=… npm run build
npx wrangler deploy && npx wrangler d1 migrations apply DB --remote
openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET
openssl rand -base64 32 | npx wrangler secret put WEBHOOK_KEY_ENCRYPTION_KEY
git checkout wrangler.jsonc   # put the placeholders back
```

**Checks:** GitHub Actions (`.github/workflows/checks.yml`) runs the typecheck, the build, and the full end-to-end test on every push and pull request. A failing check doesn't stop Cloudflare's deploy, so fix it promptly or revert.

</details>
