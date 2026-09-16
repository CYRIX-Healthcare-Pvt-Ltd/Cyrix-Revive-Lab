# Cyrix Revive Lab

Repair tracking for defective spares — from the hospital, through a Revive Lab, and back.
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
| `rl_0002_on_the_platform.sql` | the module row in `app_modules` (the portal tile) | applied once live |
| `rl_0003_names_for_the_screens.sql` | read functions that name people on visible tickets | applied |
| `rl_0004_revive_labs_not_trcs.sql` | "TRC" is the old name — messages and lab names | applied |
| `rl_0005_the_field_engineer_confirms_it_arrived.sql` | only the field engineer marks Received back | applied |
| `rl_0006_the_software_administrator_can_delete_a_ticket.sql` | SW admin deletes a ticket; numbering restarts when none remain | applied |
| `rl_0007_the_route_card.sql` | route card fields (form CHPL/CRL/SRC); photos and voice note bucket | applied |

Everything is `revive_`-prefixed. Shared tables are read, never altered — `rl_0002`
adds one row to `app_modules`, and `revive_save_member` grants the module in
`employee_modules` to people given a box.

## Deploy

Vercel project named **cyrix-revive-Revive Lab** (the portal rewrites to
`cyrix-revive-Revive Lab.vercel.app`), with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
set. Never put the service role key or database URL in Vercel.
