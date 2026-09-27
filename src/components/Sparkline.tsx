import { useId } from 'react'

interface SparklineProps {
  data: number[]
  height?: number
  width?: number
  color?: string
  className?: string
  /** Draw a soft area under the line. */
  area?: boolean
}

export interface SparklineGeometry {
  /** One [x, y] per sample, newest last. */
  coords: [number, number][]
  line: string
  fill: string
}

const PAD_RATIO = 0.15

/**
 * Maps samples onto the box. Exported so the scaling can be tested without a
 * DOM: the graph has to show a transfer that is merely *steady*, not only one
 * that is accelerating.
 */
export function sparklineGeometry(data: number[], width: number, height: number): SparklineGeometry {
  // Guard the inputs: a single non-finite sample would otherwise poison the
  // whole path (`d="M NaN NaN…"`) and the browser would draw nothing at all.
  const values = data.map((value) => (Number.isFinite(value) && value > 0 ? value : 0))
  const points = values.length > 1 ? values : values.length === 1 ? [values[0]!, 0] : [0, 0]

  const max = Math.max(...points)
  const min = Math.min(...points)
  const span = max - min
  // Pad the range so variation is visible even on a steady transfer (scaling
  // from a hard 0 baseline flattens a constant rate onto the top edge). An
  // idle series still gets a flat line on the floor, never a divide-by-zero.
  const pad = span > 0 ? span * PAD_RATIO : Math.max(max, 1) * PAD_RATIO
  const hi = max + pad
  const lo = Math.max(0, min - pad)
  const range = Math.max(hi - lo, Number.EPSILON)

  const top = 1.5
  const bottom = height - 1.5
  const last = points.length - 1
  const coords = points.map((value, index) => {
    const x = (index / last) * width
    const y = bottom - ((value - lo) / range) * (bottom - top)
    return [x, y] as [number, number]
  })

  const line = coords
    .map(([x, y], i) => {
      if (i === 0) return `M ${x.toFixed(2)} ${y.toFixed(2)}`
      const [px, py] = coords[i - 1]!
      const cx = (px + x) / 2
      return `C ${cx.toFixed(2)} ${py.toFixed(2)} ${cx.toFixed(2)} ${y.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)}`
    })
    .join(' ')

  return { coords, line, fill: `${line} L ${width} ${height} L 0 ${height} Z` }
}

/**
 * Tiny dependency-free SVG sparkline. Scales to its container, so pass only the
 * aspect you care about.
 */
export function Sparkline({ data, height = 34, width = 120, color = 'var(--brand)', className, area = true }: SparklineProps) {
  const gradientId = useId()
  const { line, fill } = sparklineGeometry(data, width, height)

  return (
    <svg
      className={className}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height }}
      aria-hidden
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.32" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {area && <path d={fill} fill={`url(#${gradientId})`} />}
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
