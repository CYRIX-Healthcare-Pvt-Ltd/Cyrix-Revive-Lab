import { Component, type ErrorInfo, type ReactNode } from 'react'
import { RefreshCw, AlertTriangle } from 'lucide-react'

/**
 * Whatever else goes wrong, not a blank page.
 *
 * There was no boundary anywhere in this app, which means every render
 * error and every failed chunk ended the same way: React unmounted the
 * tree and left white. Somebody on a service floor sees an app that has
 * simply stopped, with nothing to read and nothing to press, and the
 * only thing they can do is guess that refreshing might help.
 *
 * A blank screen also tells us nothing afterwards. This one says what
 * happened, offers the button that usually fixes it, and puts the real
 * error in the console where it can be read off somebody's phone.
 *
 * A class component because that is still the only way to catch a render
 * error in React — there is no hook for this.
 */
interface Props { children: ReactNode }
interface State { error: Error | null }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The only record there is. Worth keeping until something like
    // Sentry exists — see architecture.md, "No observability".
    console.error('Unhandled error', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children

    /*
      Two different messages, because they have two different causes and
      only one of them is the person's problem.

      A chunk that will not load is almost always a deploy that happened
      while their tab was open — nothing is broken, they are holding half
      of an older copy, and reloading genuinely fixes it. Anything else
      is a real fault and should not be dressed up as routine.
    */
    const stale = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i
      .test(this.state.error.message)

    return (
      <div className="flex min-h-screen items-center justify-center bg-ink-50 px-4">
        <div className="card w-full max-w-sm p-6 text-center">
          <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-amber-100">
            <AlertTriangle className="h-5 w-5 text-amber-700" />
          </span>
          <h1 className="mt-4 text-lg font-semibold text-ink-900">
            {stale ? 'A new version is ready' : 'Something went wrong'}
          </h1>
          <p className="mt-1.5 text-sm text-ink-600">
            {stale
              ? 'The app was updated while this was open. Reload to pick it up — nothing you have entered is lost.'
              : 'This screen could not be shown. Reloading usually clears it. If it keeps happening, tell HR what you were doing.'}
          </p>
          <button
            onClick={() => window.location.reload()}
            className="btn-primary mt-5 w-full justify-center"
          >
            <RefreshCw className="h-4 w-4" /> Reload
          </button>
          {!stale && (
            // Enough for somebody to read down the phone, and never a
            // stack trace at a service engineer.
            <p className="mt-3 break-words text-xs text-ink-400">
              {this.state.error.message.slice(0, 140)}
            </p>
          )}
        </div>
      </div>
    )
  }
}
