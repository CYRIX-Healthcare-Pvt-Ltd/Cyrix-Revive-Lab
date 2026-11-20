/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
  readonly VITE_AUTH_EMAIL_DOMAIN?: string
  /** CYRA (src/lib/cyraLink.ts); all optional, with production defaults. */
  readonly VITE_CYRA_URL?: string
  readonly VITE_CYRA_API?: string
  /** 'true' = Close repair waits for the repair to be recorded in CYRA. Off by default. */
  readonly VITE_CYRA_RECORD_REQUIRED?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/**
 * Stamped in by vite.config.ts at build time — see buildSha() there.
 * Replaced literally by the bundler, so these are constants in the
 * shipped code rather than anything read at runtime.
 */


