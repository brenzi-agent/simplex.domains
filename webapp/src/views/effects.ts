// Events met while a screen is drawn wait for the drawing to end, so a draw that throws leaves none for a later state.
export function oneAtATime<E>(take: (event: E) => void): (event: E) => void {
  let drawing = false
  const queued: E[] = []
  const dispatch = (event: E): void => {
    if (drawing) return void queued.push(event)
    drawing = true
    try {
      take(event)
    } finally {
      drawing = false
      const next = queued.shift()
      if (next) dispatch(next)
    }
  }
  return dispatch
}

export function every(ms: number, f: () => void, signal: AbortSignal): void {
  if (signal.aborted) return
  const id = setInterval(f, ms)
  signal.addEventListener("abort", () => clearInterval(id), { once: true })
}

export function after(ms: number, f: () => void, signal: AbortSignal): () => void {
  if (signal.aborted) return () => undefined
  const stop = () => clearTimeout(id)
  const id = setTimeout(() => {
    signal.removeEventListener("abort", stop)
    f()
  }, ms)
  signal.addEventListener("abort", stop, { once: true })
  return () => {
    stop()
    signal.removeEventListener("abort", stop)
  }
}
