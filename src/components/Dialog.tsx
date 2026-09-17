import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

/**
 * A small question over the page: the expected date when a repair is
 * accepted, a confirmation before scrap, a bill to attach.
 *
 * A sheet from the bottom on a phone, where the thumb is; a card in the
 * middle on a computer. Escape, the cross or a tap outside closes it, and
 * the page behind does not scroll while it is open.
 */
export default function Dialog({
  title, icon, children, onClose, wide = false,
}: {
  title: string
  icon?: ReactNode
  children: ReactNode
  onClose: () => void
  wide?: boolean
}) {
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    // The first field, so a date or an amount can be typed straight away.
    panel.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus()
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
      opener?.focus?.()
    }
  }, [onClose])

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-end justify-center bg-shade/60 sm:items-center sm:p-4"
    >
      <div
        ref={panel}
        onClick={e => e.stopPropagation()}
        className={`animate-pop-in max-h-[90vh] w-full overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl ${wide ? 'sm:max-w-xl' : 'sm:max-w-md'}`}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="flex items-center gap-2.5 text-base font-semibold text-ink-900">{icon}{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="btn-press -mr-1 -mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-500 hover:bg-ink-100 hover:text-ink-900"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="mt-4 space-y-3">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
