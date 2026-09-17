import { supabase, friendlyError } from './supabase'
import { ATTACHMENT_BUCKET } from './attachments'
import { extensionFor } from './media'

/**
 * A component request's photo and its bill, in the ticket's own folder:
 *
 *   <ticket>/parts/<request>/photo.jpg     the engineer's photo of the part
 *   <ticket>/parts/<request>/bill-1.jpg    the bill, up to three pages
 *
 * The storage rules (rl_0013) let the engineer who asked put up the photo,
 * and whoever buys it — the desk for a local purchase, Purchase for a
 * purchase — the bill, while it is being bought. Whoever can see the ticket
 * can see both.
 */
export type PartFile = 'photo' | 'bill-1' | 'bill-2' | 'bill-3'

export const partFilePath = (ticketId: string, requestId: string, file: PartFile, mime: string) =>
  `${ticketId}/parts/${requestId}/${file}.${extensionFor(mime) || 'jpg'}`

/** Uploads one file; a second try replaces the first rather than failing on it. */
export async function uploadPartFile(ticketId: string, requestId: string, file: PartFile, blob: Blob): Promise<string> {
  const path = partFilePath(ticketId, requestId, file, blob.type)
  const { error } = await supabase.storage
    .from(ATTACHMENT_BUCKET)
    .upload(path, blob, { contentType: blob.type || 'image/jpeg', upsert: true })
  if (error) throw new Error(friendlyError(error))
  return path
}

/** Links to show files by, good for an hour. Paths that fail come back without one. */
export async function signedLinks(paths: string[]): Promise<Record<string, string>> {
  if (paths.length === 0) return {}
  const { data, error } = await supabase.storage.from(ATTACHMENT_BUCKET).createSignedUrls(paths, 3600)
  if (error) throw new Error(friendlyError(error))
  const out: Record<string, string> = {}
  for (const row of data ?? []) if (row.path && row.signedUrl) out[row.path] = row.signedUrl
  return out
}
