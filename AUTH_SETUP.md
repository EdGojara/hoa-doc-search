# Auth setup — Microsoft 365 sign-in

One-time setup. After this, your team signs in at `app.bedrocktxai.com/login.html` with their Microsoft 365 accounts.

---

## Step 1 · Register an Azure AD app (Microsoft side)

1. Sign in to [Azure portal](https://portal.azure.com) with your **bedrocktx.com admin account**.
2. Search **App registrations** → **+ New registration**.
3. Fill in:
   - **Name:** `Bedrock trustEd`
   - **Supported account types:** *Accounts in this organizational directory only — Single tenant* (locks to bedrocktx.com only)
   - **Redirect URI:** `Web` → `https://<your-supabase-project>.supabase.co/auth/v1/callback`
     - Get the exact URL from Supabase: **Authentication → URL Configuration → Site URL** shows your project's `.supabase.co` domain
4. Click **Register**.
5. On the new app's **Overview** page, copy:
   - **Application (client) ID** → save it
   - **Directory (tenant) ID** → save it
6. Go to **Certificates & secrets** → **+ New client secret**:
   - Description: `trustEd prod`
   - Expires: `24 months` (set a calendar reminder to rotate before expiry)
   - Click **Add**, then **immediately copy the `Value`** (Azure only shows it once)

---

## Step 2 · Configure Supabase Auth

1. Open [Supabase dashboard](https://supabase.com/dashboard) → your project.
2. **Authentication → Providers** → **Azure (Microsoft)** → toggle **Enabled**.
3. Paste:
   - **Application (client) ID** (from Step 1.5)
   - **Secret Value** (from Step 1.6)
   - **Azure Tenant URL:** `https://login.microsoftonline.com/<your-tenant-id>/v2.0`
     - Replace `<your-tenant-id>` with the Directory (tenant) ID from Step 1.5
4. Click **Save**.

5. Still in Supabase Auth, go to **URL Configuration**:
   - **Site URL:** `https://app.bedrocktxai.com`
   - **Redirect URLs** (add both):
     - `https://app.bedrocktxai.com/**`
     - `https://app.bedrocktxai.com/login.html`
   - **Save**.

---

## Step 3 · Run migration 039 on Supabase

In Supabase SQL Editor, paste and run `migrations/039_user_profiles.sql`. This creates the `user_profiles` table and the trigger that auto-creates a profile when someone signs in. **First user to sign in becomes admin** — make sure that's you.

---

## Step 4 · Set environment variable on Render

The browser needs the Supabase anon key to talk to Auth. Render needs one new env var:

1. Open Render → your `hoa-doc-search` service → **Environment**.
2. Add a new variable:
   - **Key:** `SUPABASE_ANON_KEY`
   - **Value:** Get this from Supabase → **Settings → API → `anon` public key** (NOT the `service_role` key)
3. Save. Render will redeploy.

> The `anon` key is safe to expose to the browser by design. Keep `service_role` server-only.

---

## Step 5 · First sign-in (Ed)

1. Open `https://app.bedrocktxai.com` — you'll be redirected to `/login.html`.
2. Click **Sign in with Microsoft** → sign in with your `@bedrocktx.com` account.
3. Microsoft → Supabase → back to trustEd. You land on the app.
4. The header shows your name + role `admin` (because the trigger sets the first user to admin).
5. In Supabase SQL Editor, run this to confirm:
   ```sql
   SELECT email, role, last_sign_in_at FROM user_profiles ORDER BY created_at;
   ```

---

## Step 6 · Onboard the team

Each team member:
1. Goes to `https://app.bedrocktxai.com`
2. Signs in with their `@bedrocktx.com` Microsoft account
3. Lands on the app with role `staff`

To promote someone to admin later:
```sql
UPDATE user_profiles SET role = 'admin' WHERE email = 'someone@bedrocktx.com';
```

To deactivate someone (offboarding):
```sql
UPDATE user_profiles SET is_active = false WHERE email = 'someone@bedrocktx.com';
```
(Note: this flag is recorded but not yet enforced — we'll wire enforcement when we build action-gating in the next session.)

---

## What's working after this setup

- Login required to use the app at `app.bedrocktxai.com`
- Public homeowner pages (`/apply/:slug`, `/nominate/:slug`, `/pool-fob`, `/forms/*`, status lookup) remain unauthenticated — homeowners never need to sign in
- Header shows who you are + your role
- Sign-out button in the header
- Every action through the app is now identifiable (foundation for the audit trail we add next)

## What's NOT yet enforced (coming next session)

- Per-role gating of destructive/admin-only actions (the auth pill *hides* admin-only UI from non-admins via `data-admin-only`, but server-side enforcement is the next layer)
- Per-user community assignment / filtered "your book" views
- Audit log of who did what when
