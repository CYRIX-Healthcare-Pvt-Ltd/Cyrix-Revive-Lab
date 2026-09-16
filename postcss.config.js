import { fileURLToPath } from 'node:url'

export default {
  plugins: {
    /* This app's own Tailwind config, found from this file. Left to itself
       Tailwind looks in the folder the dev server was started from, and a
       server started from the KPI folder built this app with KPI's config —
       every class only Revive Lab uses went missing, locally only. */
    tailwindcss: { config: fileURLToPath(new URL('./tailwind.config.js', import.meta.url)) },
    autoprefixer: {},
  },
}
