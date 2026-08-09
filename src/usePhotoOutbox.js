import { useEffect, useState } from 'react'
import { getOutboxCounts, subscribeOutbox, drainPhotoOutbox, startOutbox } from './lib/photoOutbox.js'

// Gives a view the current outbox counts (live-updating) and ensures the
// background drain is running. Used by the Field board and My Day to show
// "syncing" badges and the "N queued" banner.
//
//   const { pending, byStop, draining } = usePhotoOutbox()
export default function usePhotoOutbox() {
  const [counts, setCounts] = useState({ pending: 0, byStop: {} })

  useEffect(() => {
    let alive = true
    startOutbox() // idempotent — wires the online listener + interval once
    const pull = () => getOutboxCounts().then((c) => { if (alive) setCounts(c) }).catch(() => {})
    pull()
    const unsub = subscribeOutbox(pull) // re-pull whenever the queue changes
    // When the view regains focus (e.g. tech backgrounded the app), drain + refresh.
    const onVis = () => { if (document.visibilityState === 'visible') { drainPhotoOutbox().catch(() => {}); pull() } }
    document.addEventListener('visibilitychange', onVis)
    return () => { alive = false; unsub(); document.removeEventListener('visibilitychange', onVis) }
  }, [])

  return { pending: counts.pending, byStop: counts.byStop }
}
