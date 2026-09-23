import { supabase, friendlyError } from './supabase'
import { extensionFor } from './media'

/**
 * A ticket's photos, video and voice note, in the private revive-attachments bucket.
 *
 * One folder per ticket, named by its id, and four names a file can have:
 * image-1, image-2, video and voice. The bucket's own rules (rl_0007,
 * rl_0008) decide who may read, add and remove — whoever can see the ticket
 * reads; whoever raised it, or the field engineer named on it, adds — and
 * the names are what hold a ticket to two photos, one video and one voice
 * note.
 */
export const ATTACHMENT_BUCKET = 'revive-attachments'

export type Slot = 'image-1' | 'image-2' | 'video' | 'voice'

/**
 * What the steps after the route card add to the same folder (rl_0015):
 * how the spare arrived, the repair that worked, how it came back, and an
 * observation spoken rather than typed. The storage rules give each of
 * those to the person whose step it is — the desk that accepted it, the
 * engineer repairing it, the field engineer it went back to.
 *
 * A spare the field engineer sent back, not working, goes round again, and
 * that round's files carry it — arrival-1-r2, done-voice-r2 — beside the
 * first round's and never over them (rl_0027).
 */
export type StageName =
  | 'arrival-1' | 'arrival-2'
  | 'done-1' | 'done-2' | 'done' | 'done-voice'
  | 'return-1' | 'return-2'
export type StageFile = StageName | `${StageName}-r${number}` | `voice-${number}`

/** A step's file in its round. The first round's has no suffix: everything uploaded before keeps its name. */
export const inRound = (name: StageName, round = 1): StageFile => (round > 1 ? `${name}-r${round}` : name)
export type AttachmentKind = 'image' | 'video' | 'voice'

export interface Attachment {
  slot: Slot
  path: string
  kind: AttachmentKind
  /** A signed link, good for an hour. */
  url: string
}

const DEFAULT_EXT: Record<Slot, string> = { 'image-1': 'jpg', 'image-2': 'jpg', video: 'webm', voice: 'webm' }

export const pathFor = (ticketId: string, slot: Slot, mime: string) =>
  `${ticketId}/${slot}.${extensionFor(mime) || DEFAULT_EXT[slot]}`

export const slotOf = (name: string): Slot | null => {
  const m = name.match(/^(image-1|image-2|video|voice)\./)
  return m ? (m[1] as Slot) : null
}

export const kindOf = (slot: Slot): AttachmentKind =>
  slot === 'video' ? 'video' : slot === 'voice' ? 'voice' : 'image'

/** Uploads one file into its slot. Never overwrites: a slot that is taken refuses. */
export async function uploadAttachment(ticketId: string, slot: Slot, blob: Blob): Promise<void> {
  const { error } = await supabase.storage
    .from(ATTACHMENT_BUCKET)
    .upload(pathFor(ticketId, slot, blob.type), blob, { contentType: blob.type, upsert: false })
  if (error) throw new Error(friendlyError(error))
}

/**
 * Uploads one of those, and gives back the path to record on the ticket.
 * A second try replaces the first: a photograph taken again before the
 * form is sent should not be refused by the one taken by mistake.
 */
export async function uploadStageFile(ticketId: string, file: StageFile, blob: Blob): Promise<string> {
  const fallback = blob.type.startsWith('video/') ? 'webm' : blob.type.startsWith('audio/') ? 'webm' : 'jpg'
  const path = `${ticketId}/${file}.${extensionFor(blob.type) || fallback}`
  const { error } = await supabase.storage
    .from(ATTACHMENT_BUCKET)
    .upload(path, blob, { contentType: blob.type || 'image/jpeg', upsert: true })
  if (error) throw new Error(friendlyError(error))
  return path
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
      return { slot, path: paths[i], kind: kindOf(slot), url: signed?.[i]?.signedUrl ?? '' }
    })
    .filter(a => a.url)
    .sort((a, b) => a.slot.localeCompare(b.slot))
}

/** Removes one file — to replace it. */
export async function removeAttachment(path: string): Promise<void> {
  const { error } = await supabase.storage.from(ATTACHMENT_BUCKET).remove([path])
  if (error) throw new Error(friendlyError(error))
}

/**
 * Deletes a ticket's video, if it has one.
 *
 * Called when the spare is confirmed back, and again whenever a closed
 * ticket is opened by somebody allowed to remove files — a clip explains a
 * fault to the Revive Lab, and once the spare is back that job is done; it
 * is the one attachment large enough to fill the bucket. Returns whether a
 * video was removed. Never throws: storage tidying must not turn a finished
 * ticket into an error on somebody's screen.
 */
export async function removeVideoOf(ticketId: string): Promise<boolean> {
  try {
    const { data } = await supabase.storage.from(ATTACHMENT_BUCKET).list(ticketId, { limit: 10 })
    const videos = (data ?? []).filter(f => slotOf(f.name) === 'video').map(f => `${ticketId}/${f.name}`)
    if (videos.length === 0) return false
    const { error } = await supabase.storage.from(ATTACHMENT_BUCKET).remove(videos)
    return !error
  } catch {
    return false
  }
}
