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

/**
 * Tiny dependency-free SVG sparkline. Scales to its container, so pass only the
 * aspect you care about.
 */
export function Sparkline({ data, height = 34, width = 120, color = 'var(--brand)', className, area = true }: SparklineProps) {
  const gradientId = useId()
  const points = data.length > 1 ? data : [0, ...data, 0]
  const max = Math.max(...points, 1)
  const min = Math.min(...points, 0)
  const span = Math.max(1, max - min)

  const coords = points.map((value, index) => {
    const x = (index / (points.length - 1)) * width
    const y = height - ((value - min) / span) * (height - 3) - 1.5
    return [x, y] as const
  })

  const line = coords
    .map(([x, y], i) => {
      if (i === 0) return `M ${x.toFixed(2)} ${y.toFixed(2)}`
      const [px, py] = coords[i - 1]!
      const cx = (px + x) / 2
      return `C ${cx.toFixed(2)} ${py.toFixed(2)} ${cx.toFixed(2)} ${y.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)}`
    })
    .join(' ')

  const fill = `${line} L ${width} ${height} L 0 ${height} Z`

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
