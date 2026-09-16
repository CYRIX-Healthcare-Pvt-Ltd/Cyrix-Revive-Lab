/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
  readonly VITE_AUTH_EMAIL_DOMAIN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/**
 * Stamped in by vite.config.ts at build time — see buildSha() there.
 * Replaced literally by the bundler, so these are constants in the
 * shipped code rather than anything read at runtime.
 */


