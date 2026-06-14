import { useEffect, useMemo, useRef, useState } from 'react'
import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceCollide,
  forceSimulation,
  forceX,
  forceY,
} from 'd3-force'

/**
 * Run a d3-force simulation over the graph nodes/links and expose a live world
 * position map. Positions persist across data refreshes (matched by node id).
 *
 * Layout is tuned to SPREAD across the available area instead of clumping in the
 * centre, and scales its forces with node count so 7 or 200 nodes both fill the
 * canvas nicely. Positions are in "world" coordinates; the camera (zoom/pan)
 * lives in the renderer, so the simulation is resolution independent.
 */
export function useForceLayout(graph, width, height) {
  const simRef = useRef(null)
  const nodesRef = useRef(new Map())
  const posRef = useRef(new Map())
  const [version, setVersion] = useState(0)
  const draggingRef = useRef(null)
  const graphRef = useRef(graph)
  graphRef.current = graph

  // Structural signature: node ids + undirected link pairs. The simulation is
  // rebuilt ONLY when this changes (first load, filter change). A routine data
  // refresh (same nodes/links, new loss values) keeps the identical signature,
  // so positions stay frozen and the cloud never "jumps" under the cursor.
  const structSig = useMemo(() => {
    if (!graph) return ''
    const nodeIds = graph.nodes.map((n) => n.id).sort()
    const pairs = graph.links
      .filter((l) => l.source !== l.target)
      .map((l) => (l.source < l.target ? `${l.source}|${l.target}` : `${l.target}|${l.source}`))
      .sort()
    return `${nodeIds.join(',')}#${pairs.join(',')}`
  }, [graph])

  useEffect(() => {
    const graph = graphRef.current
    if (!graph || !width || !height) return undefined

    const n = Math.max(1, graph.nodes.length)
    // Spread radius grows with sqrt(n): area ∝ n keeps density roughly constant.
    const spread = Math.max(Math.min(width, height) * 0.42, 90 * Math.sqrt(n))
    const cx = width / 2
    const cy = height / 2

    const existing = nodesRef.current
    const nodes = graph.nodes.map((d, i) => {
      const prev = existing.get(d.id)
      const ang = (i / n) * Math.PI * 2
      return {
        id: d.id,
        degree: d.degree,
        netspaces: d.netspaces,
        x: prev?.x ?? cx + Math.cos(ang) * spread * (0.6 + Math.random() * 0.4),
        y: prev?.y ?? cy + Math.sin(ang) * spread * (0.6 + Math.random() * 0.4),
        vx: prev?.vx ?? 0,
        vy: prev?.vy ?? 0,
      }
    })
    const nodeById = new Map(nodes.map((nn) => [nn.id, nn]))
    nodesRef.current = nodeById

    const links = graph.links
      .filter((l) => !l.selfLoop && l.source !== l.target)
      .map((l) => ({ source: l.source, target: l.target }))

    // Force tuning scales with node count.
    const charge = -Math.max(160, 1400 / Math.sqrt(n))
    const linkDist = Math.max(60, (spread / Math.sqrt(n)) * 1.4)

    const sim = forceSimulation(nodes)
      .force('charge', forceManyBody().strength(charge).distanceMax(spread * 2.2))
      .force(
        'link',
        forceLink(links)
          .id((d) => d.id)
          .distance(linkDist)
          .strength(0.08),
      )
      // Mild centring + axis spreading => fills the rectangle, not a blob.
      .force('x', forceX(cx).strength(0.035))
      .force('y', forceY(cy).strength(0.05))
      .force('center', forceCenter(cx, cy).strength(0.02))
      .force('collide', forceCollide().radius(26).strength(0.9))
      .alpha(0.9)
      .alphaDecay(0.025)

    const pos = posRef.current
    sim.on('tick', () => {
      for (const nn of nodes) {
        if (draggingRef.current?.id === nn.id) continue
        pos.set(nn.id, { x: nn.x, y: nn.y })
      }
      setVersion((v) => (v + 1) & 0xffffff)
    })

    for (const id of [...pos.keys()]) {
      if (!nodeById.has(id)) pos.delete(id)
    }

    simRef.current = sim
    return () => sim.stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structSig, width, height])

  const api = {
    positions: posRef.current,
    version,
    reheat() {
      simRef.current?.alpha(0.8).restart()
    },
    startDrag(id, x, y) {
      const node = nodesRef.current.get(id)
      if (!node) return
      draggingRef.current = { id }
      node.fx = x
      node.fy = y
      simRef.current?.alphaTarget(0.2).restart()
    },
    drag(id, x, y) {
      const node = nodesRef.current.get(id)
      if (!node) return
      node.fx = x
      node.fy = y
      posRef.current.set(id, { x, y })
    },
    endDrag(id) {
      const node = nodesRef.current.get(id)
      if (node) {
        node.fx = null
        node.fy = null
      }
      draggingRef.current = null
      simRef.current?.alphaTarget(0)
    },
  }
  return api
}
