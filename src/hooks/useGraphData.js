import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchGraph } from '../lib/api.js'
import { isRelative } from '../lib/time.js'

const LIVE_POLL_MS = 10000

/**
 * Load the graph for a range/filters and, when the range is "live" (tracks now),
 * refresh it on an interval. Returns data plus loading/error state and a manual
 * refresh.
 */
export function useGraphData(range, filters, minLoss, host) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const abortRef = useRef(null)
  const reqIdRef = useRef(0)

  const load = useCallback(
    async (showSpinner = true) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      const reqId = ++reqIdRef.current
      if (showSpinner) setLoading(true)
      try {
        const result = await fetchGraph(
          { from: range.from, to: range.to, filters, minLoss, host },
          controller.signal,
        )
        if (reqId === reqIdRef.current) {
          setData(result)
          setError(null)
        }
      } catch (err) {
        if (err?.name !== 'AbortError' && reqId === reqIdRef.current) {
          setError(err?.message ?? String(err))
        }
      } finally {
        if (reqId === reqIdRef.current) setLoading(false)
      }
    },
    [range.from, range.to, filters, minLoss, host],
  )

  useEffect(() => {
    load(true)
    return () => abortRef.current?.abort()
  }, [load])

  // Live polling when the range ends at "now".
  useEffect(() => {
    const live = isRelative(range.to)
    if (!live) return undefined
    const id = setInterval(() => load(false), LIVE_POLL_MS)
    return () => clearInterval(id)
  }, [range.to, load])

  return { data, loading, error, refresh: () => load(true) }
}
