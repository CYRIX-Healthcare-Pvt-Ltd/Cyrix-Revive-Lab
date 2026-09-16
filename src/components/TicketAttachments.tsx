import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ImageOff, Trash2 } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import type { Ticket } from '@/lib/queries'
import {
  listAttachments, removeAttachment, removeVideoOf, uploadAttachment, type Attachment, type Slot,
} from '@/lib/attachments'
import { Alert, Spinner } from '@/components/ui'
import { MediaCapture, type PendingPhoto } from '@/components/Attachments'

/**
 * Issue identified — what was written, photographed, filmed and said.
 *
 * Everybody who can see the ticket sees and hears these. The person who
 * raised it, or the field engineer named on it, can add into a slot still
 * free — which is also how a file that did not upload when the ticket was
 * raised gets sent — and take one away to replace it. Once the ticket is
 * closed the video is deleted: it explained a fault, the spare is back, and
 * it is the one file large enough to fill the bucket.
 */
export default function TicketAttachments({ ticket: t }: { ticket: Ticket }) {
  const { employee, me } = useAuth()
  const qc = useQueryClient()
  const { data: files, isLoading, error } = useQuery({
    queryKey: ['revive', 'attachments', t.id],
    // Signed links last an hour; refetch well before that.
    staleTime: 30 * 60_000,
    queryFn: () => listAttachments(t.id),
  })

  const closed = t.status === 'closed'
  const isSender = !!employee && (t.raised_by === employee.id || t.stakeholder_id === employee.id)
  const canAdd = isSender && !closed

  const images = (files ?? []).filter(f => f.kind === 'image')
  const videoFile = (files ?? []).find(f => f.kind === 'video')
  const voiceFile = (files ?? []).find(f => f.kind === 'voice')
  const freeImageSlots: Slot[] = (['image-1', 'image-2'] as Slot[]).filter(s => !images.some(i => i.slot === s))

  /*
    A closed ticket still holding its video — the close happened on a phone
    that lost signal, or before this rule existed. Whoever is allowed to
    remove files and opens it finishes the job; nobody else sees a thing.
  */
  useEffect(() => {
    if (!closed || !videoFile || !(isSender || me?.is_sw_admin)) return
    void removeVideoOf(t.id).then(removed => {
      if (removed) qc.invalidateQueries({ queryKey: ['revive', 'attachments', t.id] })
    })
  }, [closed, videoFile, isSender, me?.is_sw_admin, t.id, qc])

  const [newPhotos, setNewPhotos] = useState<PendingPhoto[]>([])
  const [newVideo, setNewVideo] = useState<Blob | null>(null)
  const [newVoice, setNewVoice] = useState<Blob | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)

  const refresh = () => qc.invalidateQueries({ queryKey: ['revive', 'attachments', t.id] })

  const send = async () => {
    setBusy(true); setMessage(null)
    try {
      await Promise.all([
        ...newPhotos.map((p, i) => uploadAttachment(t.id, freeImageSlots[i], p.blob)),
        ...(newVideo ? [uploadAttachment(t.id, 'video', newVideo)] : []),
        ...(newVoice ? [uploadAttachment(t.id, 'voice', newVoice)] : []),
      ])
      newPhotos.forEach(p => URL.revokeObjectURL(p.preview))
      setNewPhotos([]); setNewVideo(null); setNewVoice(null)
      setMessage({ kind: 'success', text: 'Added.' })
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'That did not upload.' })
    } finally {
      setBusy(false)
      refresh()
    }
  }

  const remove = async (a: Attachment) => {
    setBusy(true); setMessage(null)
    try { await removeAttachment(a.path) }
    catch (err) { setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Could not remove that.' }) }
    finally { setBusy(false); refresh() }
  }

  const RemoveButton = ({ a, label }: { a: Attachment; label: string }) => canAdd ? (
    <button type="button" className="btn-secondary !px-2.5 !py-1.5 text-xs" onClick={() => void remove(a)} disabled={busy}>
      <Trash2 className="h-3.5 w-3.5" /> {label}
    </button>
  ) : null

  const hasPending = newPhotos.length > 0 || !!newVideo || !!newVoice

  // "Add photos, a video or a voice note" — only what the ticket has room for.
  const addable = [
    freeImageSlots.length > 1 ? 'photos' : freeImageSlots.length === 1 ? 'a photo' : null,
    videoFile ? null : 'a video',
    voiceFile ? null : 'a voice note',
  ].filter(Boolean).join(', ').replace(/, ([^,]*)$/, ' or $1')

  return (
    <div className="card overflow-hidden">
      <div className="border-b border-ink-200 bg-ink-50 px-4 py-2.5">
        <h3 className="text-sm font-semibold text-ink-800">Issue identified</h3>
      </div>
      <div className="space-y-4 p-4">
        {message && <Alert kind={message.kind}>{message.text}</Alert>}

        <p className="whitespace-pre-wrap text-sm text-ink-900">
          {t.issue || <span className="text-ink-400">Not described.</span>}
        </p>

        {isLoading ? (
          <Spinner className="h-4 w-4 text-ink-400" />
        ) : error ? (
          <p className="flex items-center gap-2 text-xs text-ink-500">
            <ImageOff className="h-4 w-4" /> The photos and recordings could not be loaded just now.
          </p>
        ) : (
          <>
            {images.length > 0 && (
              <div className="flex flex-wrap gap-3">
                {images.map(a => (
                  <div key={a.path} className="relative">
                    <a href={a.url} target="_blank" rel="noreferrer" title="Open full size">
                      <img src={a.url} alt={`Photo ${a.slot.slice(-1)}`}
                        className="h-36 w-36 rounded-lg border border-ink-200 object-cover" />
                    </a>
                    {canAdd && (
                      <button type="button" onClick={() => void remove(a)} disabled={busy}
                        className="absolute right-1.5 top-1.5 rounded-full bg-black/60 p-1.5 text-white"
                        aria-label="Remove this photo">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {videoFile && !closed && (
              <div className="space-y-2">
                <video controls playsInline preload="metadata" src={videoFile.url}
                  className="aspect-video w-full max-w-md rounded-lg bg-black" />
                <RemoveButton a={videoFile} label="Remove video" />
              </div>
            )}

            {voiceFile && (
              <div className="flex flex-wrap items-center gap-2">
                <audio controls src={voiceFile.url} className="h-10 max-w-full" />
                <RemoveButton a={voiceFile} label="Remove" />
              </div>
            )}

            {closed && (
              <p className="text-xs text-ink-400">Any video is deleted once the ticket closes, to keep storage free.</p>
            )}

            {images.length === 0 && !videoFile && !voiceFile && !canAdd && !closed && (
              <p className="text-xs text-ink-400">No photos or recordings were sent.</p>
            )}

            {canAdd && (freeImageSlots.length > 0 || !videoFile || !voiceFile) && (
              <div className="space-y-3 rounded-lg border border-ink-200 p-3">
                <div>
                  <span className="label">Add {addable}</span>
                  <div className="mt-1">
                    <MediaCapture
                      photos={freeImageSlots.length > 0 ? { value: newPhotos, onChange: setNewPhotos, max: freeImageSlots.length } : undefined}
                      video={videoFile ? undefined : { value: newVideo, onChange: setNewVideo }}
                      voice={voiceFile ? undefined : { value: newVoice, onChange: setNewVoice }}
                    />
                  </div>
                </div>
                {hasPending && (
                  <button type="button" className="btn-primary" onClick={() => void send()} disabled={busy}>
                    {busy && <Spinner className="h-4 w-4" />} Send
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
