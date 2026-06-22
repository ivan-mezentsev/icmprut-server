// SQL builders for the `ping` measurement.
//
// All user-influenced values (netspace/family filters) are validated against a
// strict charset and single-quote escaped before interpolation. Time bounds are
// always numeric epoch ns derived server-side, never raw client strings.

/**
 * Escape a string literal for SQL single-quoted context.
 * @param {string} value
 */
function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

// Tag values in this dataset are short identifiers; reject anything exotic so a
// crafted filter cannot smuggle SQL even past the escaper.
const SAFE_TAG_RE = /^[A-Za-z0-9_.:-]{1,64}$/

/**
 * @param {string[]|undefined} values
 * @returns {string[]} sanitised list (invalid entries dropped)
 */
function sanitiseTagList(values) {
  if (!Array.isArray(values)) return []
  return values.map((v) => String(v)).filter((v) => SAFE_TAG_RE.test(v))
}

/**
 * Build the WHERE clause fragment for optional tag filters.
 * @param {{ netspaces?: string[], families?: string[] }} filters
 */
function buildFilterClause(filters) {
  const parts = []
  const netspaces = sanitiseTagList(filters.netspaces)
  if (netspaces.length > 0) {
    parts.push(`netspace IN (${netspaces.map(sqlLiteral).join(', ')})`)
  }
  const families = sanitiseTagList(filters.families)
  if (families.length > 0) {
    parts.push(`family IN (${families.map(sqlLiteral).join(', ')})`)
  }
  return parts.length > 0 ? ` AND ${parts.join(' AND ')}` : ''
}

const NS_PER_MS = 1_000_000n

function msToNs(ms) {
  return BigInt(Math.round(ms)) * NS_PER_MS
}

/**
 * Time-bucketed edge timeline query. One row per (bucket, src, dst, netspace,
 * family); the API layer folds these into edges with per-bucket segments.
 *
 * @param {{ fromMs: number, toMs: number, bucketSeconds: number, filters: object }} params
 */
export function buildEdgeSeriesSql({ fromMs, toMs, bucketSeconds, filters }) {
  const fromNs = msToNs(fromMs)
  const toNs = msToNs(toMs)
  const filterClause = buildFilterClause(filters)
  return `
    SELECT
      date_bin(INTERVAL '${bucketSeconds} seconds', time) AS bucket,
      src, dst, netspace, family,
      sum(sent) AS sent,
      sum(recv) AS recv,
      avg(loss) AS loss,
      min("min") AS rtt_min,
      avg(avg) AS rtt_avg,
      max("max") AS rtt_max
    FROM ping
    WHERE time >= to_timestamp_nanos(${fromNs}) AND time < to_timestamp_nanos(${toNs})${filterClause}
    GROUP BY 1, src, dst, netspace, family
    ORDER BY bucket ASC
  `.trim()
}

/**
 * Window-scoped metadata query: which nodes exist within the selected time
 * range (used to populate the node universe / filters). The meta endpoint is
 * the SOURCE of available filter values, so it is bounded ONLY by time and
 * deliberately never by netspace/family — otherwise the available list would
 * collapse to whatever is already selected.
 *
 * @param {{ fromMs: number, toMs: number }} params
 */
export function buildMetaSql({ fromMs, toMs }) {
  const fromNs = msToNs(fromMs)
  const toNs = msToNs(toMs)
  const timeClause = `time >= to_timestamp_nanos(${fromNs}) AND time < to_timestamp_nanos(${toNs})`
  return `
    SELECT DISTINCT src AS node FROM ping WHERE ${timeClause}
    UNION
    SELECT DISTINCT dst AS node FROM ping WHERE ${timeClause}
    ORDER BY node ASC
  `.trim()
}

/**
 * Window-scoped distinct netspace/family combos within the selected range.
 * @param {{ fromMs: number, toMs: number }} params
 */
export function buildNetspacesSql({ fromMs, toMs }) {
  const fromNs = msToNs(fromMs)
  const toNs = msToNs(toMs)
  return `SELECT DISTINCT netspace, family FROM ping WHERE time >= to_timestamp_nanos(${fromNs}) AND time < to_timestamp_nanos(${toNs}) ORDER BY netspace, family`
}

/**
 * Map each node to the addresses it is reached at, per netspace/family — used
 * for richer hover tooltips. Kept cheap by scanning distinct tag combos only.
 */
export function buildNodeAddrSql({ filters } = { filters: {} }) {
  const filterClause = buildFilterClause(filters)
  return `
    SELECT DISTINCT dst AS node, netspace, family, addr
    FROM ping
    WHERE addr IS NOT NULL${filterClause}
    ORDER BY node, netspace, family
  `.trim()
}
