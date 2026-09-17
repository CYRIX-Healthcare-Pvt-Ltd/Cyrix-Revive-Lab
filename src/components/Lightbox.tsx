import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, ExternalLink, X } from 'lucide-react'

export interface LightboxImage {
  src: string
  alt: string
}

/**
 * A photo, big, over the page — instead of a new tab.
 *
 * A new tab takes somebody out of the ticket to look at a picture of it,
 * and on a phone they then have to find their way back. This opens on top,
 * closes with the cross, Escape or a tap on the dark around the photo, and
 * steps between the photos with the arrows or the arrow keys. "Open
 * original" is still there for zooming right in.
 */
export default function Lightbox({
  images, index, onIndex, onClose,
}: {
  images: LightboxImage[]
  /** Which photo is open; null when closed. */
  index: number | null
  onIndex: (next: number) => void
  onClose: () => void
}) {
  const closeButton = useRef<HTMLButtonElement>(null)
  const open = index !== null && index >= 0 && index < images.length
  const count = images.length

  useEffect(() => {
    if (!open) return
    const opener = document.activeElement as HTMLElement | null
    closeButton.current?.focus()
    // The page behind stays where it was.
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = overflow
      opener?.focus?.()
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight' && count > 1) onIndex(((index ?? 0) + 1) % count)
      else if (e.key === 'ArrowLeft' && count > 1) onIndex(((index ?? 0) - 1 + count) % count)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, index, count, onClose, onIndex])

  if (!open) return null
  const image = images[index]

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={image.alt}
      className="fixed inset-0 z-50 flex items-center justify-center bg-shade/85 p-4 motion-safe:animate-[lightbox-in_160ms_ease-out]"
      onClick={onClose}
    >
      <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-2 p-3 text-white">
        <span className="rounded-full bg-shade/60 px-2.5 py-1 text-xs tabular-nums">
          {count > 1 ? `${index + 1} of ${count}` : image.alt}
        </span>
        <div className="flex items-center gap-2">
          <a
            href={image.src}
            target="_blank"
            rel="noreferrer"
            onClick={e => e.stopPropagation()}
            className="inline-flex items-center gap-1.5 rounded-full bg-shade/60 px-3 py-1.5 text-xs font-medium hover:bg-shade/80"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Open original
          </a>
          <button
            ref={closeButton}
            type="button"
            onClick={onClose}
            className="grid h-9 w-9 place-items-center rounded-full bg-shade/60 hover:bg-shade/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      <img
        key={image.src}
        src={image.src}
        alt={image.alt}
        onClick={e => e.stopPropagation()}
        className="max-h-[82vh] max-w-full rounded-lg object-contain shadow-2xl motion-safe:animate-[lightbox-photo_180ms_cubic-bezier(0.23,1,0.32,1)]"
      />

      {count > 1 && (
        <>
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onIndex((index - 1 + count) % count) }}
            className="absolute left-3 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-shade/60 text-white hover:bg-shade/80"
            aria-label="Previous photo"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onIndex((index + 1) % count) }}
            className="absolute right-3 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-shade/60 text-white hover:bg-shade/80"
            aria-label="Next photo"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        </>
      )}
    </div>,
    document.body,
  )
}
