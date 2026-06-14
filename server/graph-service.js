// Domain service: turn cached InfluxDB rows into the graph payload the UI needs.
//
// The UI wants, for the selected range/filters:
//   - nodes: every participant (src ∪ dst)
//   - edges: one per ordered (src, dst, netspace, family) pair, each carrying a
//            time-ordered list of buckets {t, loss, rtt_avg/min/max, sent, recv}
//            so the canvas can colour segments along the line by loss.
//
// Caching + coalescing is delegated to QueryCache; keys are derived from the
// resolved (quantised) range, bucket size and sanitised filters.

import config from './config.js'
import { QueryCache } from './cache.js'
import { querySql } from './influx.js'
import {
  buildEdgeSeriesSql,
  buildMetaSql,
  buildNetspacesSql,
} from './queries.js'
import { resolveRange, pickBucketSeconds } from './timerange.js'

const cache = new QueryCache({ maxEntries: config.cache.maxEntries })

/**
 * Quantise a live "to" boundary so bursts of clients share one cache key.
 */
function quantiseNow(nowMs) {
  const q = config.cache.nowQuantMs
  return Math.floor(nowMs / q) * q
}

function stableFilters(filters = {}) {
  const netspaces = Array.isArray(filters.netspaces)
    ? [...filters.netspaces].map(String).sort()
    : []
  const families = Array.isArray(filters.families)
    ? [...filters.families].map(String).sort()
    : []
  return { netspaces, families }
}

function numOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Clamp a packet-loss threshold to [0, 100] with hundredth precision.
 * Returns 0 (no filtering) for anything non-finite.
 */
function clampThreshold(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.round(Math.max(0, Math.min(100, n)) * 100) / 100
}

/** Worst-case loss a link reached over the visible range (for the threshold). */
function worstLinkLoss(link) {
  const s = link.summary
  if (!s) return 0
  if (s.lossMax != null) return s.lossMax
  if (s.lossAvg != null) return s.lossAvg
  return 0
}

/**
 * Compute a summary {sent,recv,lossAvg,lossMax,rttAvg,rttMin,rttMax} from a
 * list of {sent,recv,loss,rttAvg,rttMin,rttMax} buckets.
 */
function summariseBuckets(buckets) {
  let sent = 0
  let recv = 0
  let lossSum = 0
  let lossCount = 0
  let lossMax = null
  let rttAvgSum = 0
  let rttAvgCount = 0
  let rttMin = Infinity
  let rttMax = -Infinity
  for (const b of buckets) {
    sent += b.sent ?? 0
    recv += b.recv ?? 0
    if (b.loss != null) {
      lossSum += b.loss
      lossCount += 1
      lossMax = lossMax == null ? b.loss : Math.max(lossMax, b.loss)
    }
    if (b.rttAvg != null) {
      rttAvgSum += b.rttAvg
      rttAvgCount += 1
    }
    if (b.rttMin != null) rttMin = Math.min(rttMin, b.rttMin)
    if (b.rttMax != null) rttMax = Math.max(rttMax, b.rttMax)
  }
  return {
    sent,
    recv,
    lossAvg: lossCount > 0 ? lossSum / lossCount : sent > 0 ? ((sent - recv) * 100) / sent : null,
    lossMax,
    rttAvg: rttAvgCount > 0 ? rttAvgSum / rttAvgCount : null,
    rttMin: rttMin === Infinity ? null : rttMin,
    rttMax: rttMax === -Infinity ? null : rttMax,
  }
}

/**
 * Fold flat bucket rows into a COMPACT graph: one link per unordered node pair,
 * regardless of how many netspaces / families / directions connect them.
 *
 * Why aggregate: at production scale (~100 nodes, up to ~10 netspaces each) the
 * raw directed-per-netspace edge count explodes into the tens of thousands. A
 * single worst-case link per pair keeps the cloud readable and the canvas fast;
 * the per-direction / per-netspace breakdown is preserved in `members` for the
 * hover tooltip.
 *
 * @param {Array<Record<string, any>>} rows
 */
function foldGraph(rows) {
  const nodes = new Map()
  const links = new Map()

  const ensureNode = (id) => {
    if (!nodes.has(id)) {
      nodes.set(id, { id, netspaces: new Set(), links: new Set() })
    }
    return nodes.get(id)
  }

  for (const row of rows) {
    const src = row.src
    const dst = row.dst
    const netspace = row.netspace
    const family = row.family
    if (src == null || dst == null) continue

    const srcNode = ensureNode(src)
    const dstNode = ensureNode(dst)
    srcNode.netspaces.add(netspace)
    dstNode.netspaces.add(netspace)

    const selfLoop = src === dst
    const [a, b] = src <= dst ? [src, dst] : [dst, src]
    const pairKey = `${a}\u0000${b}`
    srcNode.links.add(pairKey)
    dstNode.links.add(pairKey)

    let link = links.get(pairKey)
    if (!link) {
      link = {
        id: pairKey,
        a,
        b,
        selfLoop,
        netspaces: new Set(),
        // merged per-bucket worst-case timeline, keyed by bucket epoch ms
        bucketMap: new Map(),
        // per (direction, netspace, family) breakdown for the tooltip
        memberMap: new Map(),
      }
      links.set(pairKey, link)
    }
    link.netspaces.add(netspace)

    const tMs = Date.parse(`${row.bucket}Z`)
    const t = Number.isFinite(tMs) ? tMs : Date.parse(row.bucket)
    const sample = {
      t,
      sent: numOrNull(row.sent) ?? 0,
      recv: numOrNull(row.recv) ?? 0,
      loss: numOrNull(row.loss),
      rttMin: numOrNull(row.rtt_min),
      rttAvg: numOrNull(row.rtt_avg),
      rttMax: numOrNull(row.rtt_max),
    }

    // Merge into the link timeline (worst-case loss, widest rtt, summed counts).
    let mb = link.bucketMap.get(t)
    if (!mb) {
      mb = { t, sent: 0, recv: 0, loss: null, rttMin: null, rttAvg: null, rttAvgN: 0, rttMax: null }
      link.bucketMap.set(t, mb)
    }
    mb.sent += sample.sent
    mb.recv += sample.recv
    if (sample.loss != null) mb.loss = mb.loss == null ? sample.loss : Math.max(mb.loss, sample.loss)
    if (sample.rttMin != null) mb.rttMin = mb.rttMin == null ? sample.rttMin : Math.min(mb.rttMin, sample.rttMin)
    if (sample.rttMax != null) mb.rttMax = mb.rttMax == null ? sample.rttMax : Math.max(mb.rttMax, sample.rttMax)
    if (sample.rttAvg != null) {
      mb.rttAvg = (mb.rttAvg ?? 0) + sample.rttAvg
      mb.rttAvgN += 1
    }

    // Accumulate the directed member breakdown.
    const memberKey = `${src}\u0000${dst}\u0000${netspace}\u0000${family}`
    let member = link.memberMap.get(memberKey)
    if (!member) {
      member = { source: src, target: dst, netspace, family, buckets: [] }
      link.memberMap.set(memberKey, member)
    }
    member.buckets.push(sample)
  }

  const linkList = []
  for (const link of links.values()) {
    const buckets = [...link.bucketMap.values()]
      .sort((x, y) => x.t - y.t)
      .map((mb) => ({
        t: mb.t,
        sent: mb.sent,
        recv: mb.recv,
        loss: mb.loss,
        rttMin: mb.rttMin,
        rttAvg: mb.rttAvgN > 0 ? mb.rttAvg / mb.rttAvgN : null,
        rttMax: mb.rttMax,
      }))
    const members = [...link.memberMap.values()]
      .map((m) => ({
        source: m.source,
        target: m.target,
        netspace: m.netspace,
        family: m.family,
        summary: summariseBuckets(m.buckets),
      }))
      .sort((x, y) => (y.summary.lossAvg ?? -1) - (x.summary.lossAvg ?? -1))
    linkList.push({
      id: link.id,
      source: link.a,
      target: link.b,
      selfLoop: link.selfLoop,
      netspaces: [...link.netspaces].filter(Boolean).sort(),
      buckets,
      members,
      summary: summariseBuckets(buckets),
    })
  }

  const nodeList = [...nodes.values()].map((n) => ({
    id: n.id,
    netspaces: [...n.netspaces].filter(Boolean).sort(),
    degree: n.links.size,
  }))

  return { nodes: nodeList, links: linkList }
}

/**
 * Public: resolve the graph for a request.
 * @param {{ from: string|number, to: string|number, filters?: object, maxBuckets?: number }} req
 */
export async function getGraph(req) {
  const realNow = Date.now()
  const nowMs = quantiseNow(realNow)
  const { fromMs, toMs, isLive } = resolveRange(req.from, req.to, nowMs)
  const filters = stableFilters(req.filters)
  const bucketSeconds = pickBucketSeconds(fromMs, toMs, req.maxBuckets ?? 240)

  // A range is "settling" when its end is recent enough that late agent writes
  // (an offline prober backfilling past windows) could still change the result.
  // Such ranges must use the short TTL so the cache never hides fresh backfill.
  const settling = toMs >= realNow - config.cache.settleMs

  const key = JSON.stringify({
    kind: 'graph',
    fromMs,
    toMs,
    bucketSeconds,
    filters,
  })
  const ttl = isLive || settling ? config.cache.liveTtlMs : config.cache.historyTtlMs

  const graph = await cache.resolve(key, ttl, async () => {
    const sql = buildEdgeSeriesSql({ fromMs, toMs, bucketSeconds, filters })
    const rows = await querySql(sql)
    return foldGraph(rows)
  })

  // Packet-loss threshold is applied AFTER the (shared) cache: the heavy query
  // + fold are reused across thresholds, and links below the threshold are
  // never serialised to the browser. Nodes/degree stay intact — only links not
  // matching the filter are dropped, so no other display logic changes.
  const minLoss = clampThreshold(req.minLoss)
  // A selected/pinned host is exempt from the threshold: ALL of its links are
  // returned (even healthy ones) so the host can be investigated in full. Other
  // hosts' links still obey the threshold to keep the payload small.
  const host = typeof req.host === 'string' && req.host ? req.host : null
  const links =
    minLoss > 0
      ? graph.links.filter(
          (l) =>
            worstLinkLoss(l) >= minLoss ||
            (host != null && (l.source === host || l.target === host)),
        )
      : graph.links

  return {
    range: { from: fromMs, to: toMs, isLive },
    bucketSeconds,
    filters,
    minLoss,
    host,
    nodes: graph.nodes,
    links,
  }
}

/**
 * Public: metadata for filters / node universe. Cached with history TTL since
 * the participant set changes slowly.
 */
export async function getMeta() {
  return cache.resolve('meta', config.cache.historyTtlMs, async () => {
    const [nodeRows, nsRows] = await Promise.all([
      querySql(buildMetaSql()),
      querySql(buildNetspacesSql()),
    ])
    const nodes = nodeRows.map((r) => r.node).filter(Boolean)
    const netspaces = [...new Set(nsRows.map((r) => r.netspace).filter(Boolean))].sort()
    const families = [...new Set(nsRows.map((r) => r.family).filter(Boolean))].sort()
    const combos = nsRows.map((r) => ({ netspace: r.netspace, family: r.family }))
    return { nodes, netspaces, families, combos }
  })
}

export function cacheStats() {
  return cache.snapshot()
}
