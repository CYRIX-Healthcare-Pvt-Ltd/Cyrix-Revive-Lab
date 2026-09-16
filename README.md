# Cyrix Revive Lab

Repair tracking for defective spares — from the hospital, through a TRC, and back.
Served at **app.cyrix.in/revive** behind the portal's rewrite, on the same Supabase
project and sign-in as KPI.

## Run locally

```bash
npm install
npm run dev          # http://localhost:5177/revive/
```

`.env.local` needs only the public values (see `.env.example`). On any host other than
app.cyrix.in the app shows its own employee-code sign-in; on app.cyrix.in the portal's
session is used.

## Database

Migrations in `supabase/migrations`, applied in order and recorded in `_migrations`:

| File | What | When |
| --- | --- | --- |
| `rl_0001_revive_lab.sql` | tables, row-level security, workflow functions | applied |
| `rl_0002_on_the_platform.sql` | the module row in `app_modules` (the portal tile) | once the Vercel app is live |
| `rl_0003_names_for_the_screens.sql` | read functions that name people on visible tickets | applied |

Everything is `revive_`-prefixed. Shared tables are read, never altered — `rl_0002`
adds one row to `app_modules`, and `revive_save_member` grants the module in
`employee_modules` to people given a box.

## Deploy

Vercel project named **cyrix-revive-lab** (the portal rewrites to
`cyrix-revive-lab.vercel.app`), with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
set. Never put the service role key or database URL in Vercel.
