// First of all: storage the browser refuses must not crash the page (lib/safeStorage).
import './lib/safeStorage'
import { startSessionGuard } from '@/lib/sessionGuard'
import { startIdleSignOut } from './lib/idleSignOut'
import { supabase } from './lib/supabase'
import { startErrorReporting } from './lib/reportErrors'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider } from '@/contexts/AuthContext'
import { startTheme } from '@/lib/theme'
import ErrorBoundary from '@/components/ErrorBoundary'
import App from './App'
import './index.css'

// Before render, so nobody sees a flash of the wrong palette, and so a
// choice made in another module is already in force when this one opens.
startTheme()
// Before React mounts, so an error during the first render is caught too (0230).
startErrorReporting(supabase, 'revive', import.meta.env.VITE_VERCEL_GIT_COMMIT_SHA?.slice(0, 7))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A ticket moves when somebody acts on it. Refetch on focus, so a
      // coordinator's acceptance appears for the field engineer without a
      // reload.
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
})

// Signed out within a minute when another device signs everybody out (0149).
startSessionGuard()
// Signed out after 3 hours with nothing done, across every Cyrix app.
startIdleSignOut(supabase)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        {/* The portal owns app.cyrix.in; this app owns /revive beneath it. */}
        <BrowserRouter basename="/revive">
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
)
