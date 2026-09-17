import clsx from 'clsx'
import type { LucideIcon } from 'lucide-react'
import { TONE_SOFT, type Tone } from '@/lib/tickets'

/**
 * An icon on a soft square of its own colour, beside a heading.
 *
 * Each section says what it is before its title is read — a truck for the
 * courier, a clipboard for the route card — and the colour tells sections
 * apart at a glance. The tones are the status tones, so they turn with the
 * theme like the badges do.
 */
export default function IconChip({
  icon: Icon, tone, className, iconClassName,
}: {
  icon: LucideIcon
  tone: Tone
  className?: string
  iconClassName?: string
}) {
  return (
    <span aria-hidden className={clsx('grid h-7 w-7 shrink-0 place-items-center rounded-lg', TONE_SOFT[tone], className)}>
      <Icon className={clsx('h-4 w-4', iconClassName)} />
    </span>
  )
}
