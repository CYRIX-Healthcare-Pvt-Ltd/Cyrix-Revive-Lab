# Cyrix Revive Lab

Repair tracking for defective spares: from the hospital where a field
engineer finds one, into a Revive Lab, through repair, and back out again, or
on to another lab or the OEM when this one cannot fix it. Each spare's journey
is a ticket (RL-01, RL-02 …) with a full status history, TAT figures, a route
card, photos, components, purchase and stock.

> Part of **Cyrix One**, the platform at [app.cyrix.in](https://app.cyrix.in).
> System-wide picture: [Cyrix One Platform — System Architecture](https://claude.ai/artifact/HNYWoBqCJ6Xh3XcREuKpTu)
> (ask Adrian for access). Every repository: [REPOSITORIES.md](https://github.com/CYRIX-Healthcare-Pvt-Ltd/cyrix-platform/blob/main/docs/REPOSITORIES.md).

## At a glance

| | |
|---|---|
| Served at | `app.cyrix.in/revive` (portal rewrite to `cyrix-revive-lab.vercel.app`) |
| Stack | React 18, TypeScript, Vite 5, Tailwind 3, react-router, `@supabase/supabase-js`, tesseract.js (bill OCR in the browser), Vitest |
| Database | Shared Supabase project (the same one as KPI); own objects all `revive_`-prefixed |
| Sign-in | The portal's session on app.cyrix.in. On any other host the app shows its own employee-code sign-in |
| Hosting | Vercel project `cyrix-revive-lab` |
| Maintainers | Kevin |
| Status | Live |

## Run locally

```bash
npm install
cp .env.example .env.local   # the two public Supabase values
npm run dev                  # http://localhost:5177/revive/
```

## Environment variables

| Name | Where it is set | Secret? | What it is for |
|---|---|---|---|
| `VITE_SUPABASE_URL` | `.env.local`, Vercel | no | The shared Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | `.env.local`, Vercel | no (publishable key) | Browser access; row-level security does the protecting |
| `VITE_AUTH_EMAIL_DOMAIN` | `.env.local`, Vercel | no | Domain an employee code becomes; defaults to `cyrix.local` |

Never put the service-role key or a database URL in `.env.local` for this app
or in Vercel: every `VITE_` value is readable by anyone who opens the site.

## Database

Migrations are in `supabase/migrations` (`rl_0001` … `rl_0057`), applied in
filename order and recorded in `_migrations`. Everything is `revive_`-prefixed.
Shared tables are read, never altered, with two exceptions: `rl_0002` adds the
module's row to `app_modules` (the portal tile), and `revive_save_member`
grants the module in `employee_modules` to people given a box.

| Migrations | What they cover |
|---|---|
| 0001–0007 | Tables, row-level security, workflow functions, module row, names on screens, "Revive Lab" replacing the old "TRC", field engineer confirms receipt, SW admin delete, route card with photos and voice note |
| 0008–0012 | State, BEMMP and district on the route card; observations during repair; spares, accessories and couriers; billing for private hospitals |
| 0013–0026 | Components, purchase and closure; states and approval to go to another lab; arrival proof; stock and its lists; warehouses; category, criticality and contract; billing estimate on dispatch |
| 0027–0038 | Return to the lab, hand-over between field engineers, My Team, TAT ending at the repair, stock bins and history, return to OEM, not-repairable needs a manager, reopening a closed repair |
| 0039–0057 | Observers, couriers, component requests without a ticket, project-head approval across states, who sees the live floor, who a ticket waits on, purchase visibility, duplicate warnings, PI requests, item codes on orders |

The migration's own header says why each rule is as it is; read it before
changing the function it touches.

## Deploy

Vercel builds `main` on every push (`npm run build` → `dist/revive`), with the three
`VITE_` variables above. Migrations are not deployed by anything: apply them
before merging code that needs them. Never put the service-role key or a
database URL in Vercel.

## Checks before merging

```bash
npm run build    # tsc --noEmit + vite build
npm test         # Vitest (src/lib/*.test.ts)
```

## How it works

- **Nobody writes a table directly.** Every change goes through a function
  that checks who is asking and whether the ticket's state allows it, and
  writes the event row in the same transaction. That is what keeps the
  history complete, and the TAT figures and notification emails are built
  from it.
- **Roles are ticked boxes, not a role name** (`revive_members`): engineer,
  coordinator, manager, purchase, observer, and admin (edit rights over the
  members list). A manager who also repairs is a manager with the engineer box
  ticked. The field engineer who sends a spare in and their reporting manager
  are not boxes: the first is whoever raised or is named on the ticket, the
  second is read from the reporting line.
- **Labs are Regional or Project** and serve one state or every state; going
  to a lab in another state needs the project head's approval (rl_0014,
  rl_0047 to rl_0049).
- **Only the field engineer marks a spare Received back** (rl_0005).

| Page | Route | Who |
|---|---|---|
| Dashboard | `/` | members |
| Tickets | `/tickets`, `/tickets/:code` | members |
| New ticket | `/new` | those who may raise |
| Team | `/team` | managers |
| Components | `/components` | coordinators, managers, admins, purchase, engineers |
| Access | `/access` | Revive Lab admins |

## Related docs

- [cyrix-platform README](https://github.com/CYRIX-Healthcare-Pvt-Ltd/cyrix-platform#readme): the portal and how a module is added
- [Cyrix-KPI](https://github.com/CYRIX-Healthcare-Pvt-Ltd/Cyrix-KPI#readme): the shared database and SW Admin
- [Cyrix-Cyra `docs/REVIVE-LAB-PLAN.md`](https://github.com/CYRIX-Healthcare-Pvt-Ltd/Cyrix-Cyra/blob/cyra-main/docs/REVIVE-LAB-PLAN.md): how Cyra Assist links to Revive Lab
