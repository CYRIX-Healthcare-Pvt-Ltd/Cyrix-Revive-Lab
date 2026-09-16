import { supabase, friendlyError } from './supabase'
import { extensionFor } from './media'

/**
 * A ticket's photos and voice note, in the private revive-attachments bucket.
 *
 * One folder per ticket, named by its id, and three names a file can have:
 * image-1, image-2 and voice. The bucket's own rules (rl_0007) decide who
 * may read, add and remove — whoever can see the ticket reads; whoever
 * raised it, or the field engineer named on it, adds — and the names are
 * what hold a ticket to two photos and one voice note.
 */
export const ATTACHMENT_BUCKET = 'revive-attachments'

export type Slot = 'image-1' | 'image-2' | 'voice'

export interface Attachment {
  slot: Slot
  path: string
  kind: 'image' | 'voice'
  /** A signed link, good for an hour. */
  url: string
}

export const pathFor = (ticketId: string, slot: Slot, mime: string) =>
  `${ticketId}/${slot}.${extensionFor(mime) || (slot === 'voice' ? 'webm' : 'jpg')}`

const slotOf = (name: string): Slot | null => {
  const m = name.match(/^(image-1|image-2|voice)\./)
  return m ? (m[1] as Slot) : null
}

/** Uploads one file into its slot. Never overwrites: a slot that is taken refuses. */
export async function uploadAttachment(ticketId: string, slot: Slot, blob: Blob): Promise<void> {
  const { error } = await supabase.storage
    .from(ATTACHMENT_BUCKET)
    .upload(pathFor(ticketId, slot, blob.type), blob, { contentType: blob.type, upsert: false })
  if (error) throw new Error(friendlyError(error))
}

/** What a ticket has, with links to show it by. */
export async function listAttachments(ticketId: string): Promise<Attachment[]> {
  const { data, error } = await supabase.storage.from(ATTACHMENT_BUCKET).list(ticketId, { limit: 10 })
  if (error) throw new Error(friendlyError(error))
  const files = (data ?? []).filter(f => slotOf(f.name))
  if (files.length === 0) return []
  const paths = files.map(f => `${ticketId}/${f.name}`)
  const { data: signed, error: signErr } = await supabase.storage
    .from(ATTACHMENT_BUCKET).createSignedUrls(paths, 3600)
  if (signErr) throw new Error(friendlyError(signErr))
  return files
    .map((f, i) => {
      const slot = slotOf(f.name)!
      return {
        slot,
        path: paths[i],
        kind: slot === 'voice' ? 'voice' as const : 'image' as const,
        url: signed?.[i]?.signedUrl ?? '',
      }
    })
    .filter(a => a.url)
    .sort((a, b) => a.slot.localeCompare(b.slot))
}

/** Removes one file — to replace a photo. */
export async function removeAttachment(path: string): Promise<void> {
  const { error } = await supabase.storage.from(ATTACHMENT_BUCKET).remove([path])
  if (error) throw new Error(friendlyError(error))
}
