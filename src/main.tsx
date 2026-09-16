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
