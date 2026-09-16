import clsx from 'clsx'

/**
 * Somebody's face, or their initials.
 *
 * The picture is a base64 data URL carried on the employee row — see
 * migration 0037 — so it arrives with the list that is already being
 * fetched and there is nothing to load. Initials stay the fallback
 * rather than a placeholder silhouette: a grey outline of a person reads
 * as "unknown", and we know exactly who this is.
 */
export function initialsOf(name: string | null | undefined): string {
  return (name ?? '?')
    .trim().split(/\s+/).slice(0, 2)
    .map(p => p[0] ?? '')
    .join('')
    .toUpperCase() || '?'
}

const SIZES = {
  /*
   * The header, and the only size that changes with the viewport.
   *
   * 32px on a phone is what Spare and BEMMP show: three headers on one
   * domain, and a face that changes size between them reads as three
   * different apps rather than one. It grows back to 36 at sm, where the
   * name sits beside it and the desktop header is unchanged — that layout
   * is settled and this is not the change that revisits it.
   */
  header: 'h-8 w-8 text-[11px] sm:h-9 sm:w-9 sm:text-xs',
  sm: 'h-9 w-9 text-xs',
  md: 'h-11 w-11 text-sm',
  lg: 'h-16 w-16 text-lg',
  xl: 'h-24 w-24 text-2xl',
} as const

export default function Avatar({
  name, src, size = 'sm', className,
}: {
  name: string | null | undefined
  src?: string | null
  size?: keyof typeof SIZES
  className?: string
}) {
  const base = clsx(
    'flex shrink-0 items-center justify-center overflow-hidden rounded-full',
    SIZES[size], className,
  )

  if (src) {
    return (
      <img
        src={src}
        // The name is on screen beside every one of these, so repeating
        // it here would have a screen reader say it twice.
        alt=""
        className={clsx(base, 'bg-ink-100 object-cover')}
        loading="lazy"
        draggable={false}
      />
    )
  }

  return (
    <span className={clsx(base, 'bg-ink-100 font-semibold text-ink-700')} aria-hidden>
      {initialsOf(name)}
    </span>
  )
}
