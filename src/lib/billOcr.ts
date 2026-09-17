/**
 * The amount on a bill, read from its photo.
 *
 * Text recognition runs in the browser (tesseract.js) — no key, no cost,
 * nothing sent anywhere. The first bill a person scans downloads the
 * recogniser and its English data, a few megabytes, once. It reads printed
 * bills well and handwriting poorly, so what it finds is only ever a
 * suggestion put into the amount box: the person checks it against the
 * photo beside it and corrects it.
 *
 * Finding the total is the part worth testing, and it needs no browser:
 * amountFromText takes the recognised text and picks the amount the bill
 * calls its total — grand total, net amount, amount payable — reading from
 * the bottom, where totals are; and failing any such line, the largest
 * amount written with paise.
 */

const TOTAL_WORDS = [
  /grand\s*total/i,
  /net\s*(amount|payable|total|amt)/i,
  /(amount|amt)\s*payable/i,
  /total\s*(amount|amt|payable|value)/i,
  /bill\s*(amount|amt|total)|invoice\s*(amount|total)/i,
  /\btotal\b/i,
]

/** 1,23,456.78 · 123456.78 · 1,234 · 240 — not a date, a phone number or a GSTIN. */
const AMOUNT = /(?<![\d/.:-])(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d{1,7}(?:\.\d{1,2})?)(?![\d/:-]|\.\d{3})/g

function amountsIn(line: string): number[] {
  // Rupee signs recognised as letters or digits ("Rs.", "₹", "%") stay out of the way.
  const cleaned = line.replace(/₹|rs\.?|inr/gi, ' ')
  const out: number[] = []
  for (const m of cleaned.matchAll(AMOUNT)) {
    const n = Number(m[1].replace(/,/g, ''))
    if (Number.isFinite(n) && n > 0 && n <= 10_000_000) out.push(n)
  }
  return out
}

export function amountFromText(text: string): number | null {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)

  for (const word of TOTAL_WORDS) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!word.test(lines[i])) continue
      // "Sub total" is not the total when the bill has one below it.
      if (/sub\s*-?\s*total/i.test(lines[i]) && word.source === '\\btotal\\b') continue
      const here = amountsIn(lines[i])
      if (here.length) return here[here.length - 1]
      const next = lines[i + 1] ? amountsIn(lines[i + 1]) : []
      if (next.length) return next[next.length - 1]
    }
  }

  const withPaise = lines.flatMap(l => [...l.replace(/₹|rs\.?|inr/gi, ' ').matchAll(AMOUNT)]
    .map(m => m[1]).filter(s => /\.\d{2}$/.test(s)).map(s => Number(s.replace(/,/g, ''))))
    .filter(n => n > 0 && n <= 10_000_000)
  return withPaise.length ? Math.max(...withPaise) : null
}

/**
 * Reads a bill photo and suggests its amount. Throws only when recognition
 * itself could not run; a bill it cannot find a total on gives null.
 */
export async function readBillAmount(
  image: Blob,
  onProgress?: (fraction: number) => void,
): Promise<{ amount: number | null; text: string }> {
  const { createWorker } = await import('tesseract.js')
  const worker = await createWorker('eng', 1, {
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text') onProgress?.(m.progress)
    },
  })
  try {
    const { data } = await worker.recognize(image)
    return { amount: amountFromText(data.text), text: data.text }
  } finally {
    await worker.terminate()
  }
}
