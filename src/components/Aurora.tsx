/**
 * Slowly drifting gradient blobs behind the whole app. Purely decorative and
 * pointer-transparent; costs nothing but a couple of composited layers.
 */
export function Aurora() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="absolute inset-0 bg-[var(--bg)]" />
      <div
        className="animate-drift absolute -top-[30%] -left-[10%] h-[70vmax] w-[70vmax] rounded-full opacity-[0.55] blur-[120px]"
        style={{
          background:
            'radial-gradient(circle at 50% 50%, color-mix(in oklab, var(--brand) 55%, transparent), transparent 62%)',
        }}
      />
      <div
        className="animate-drift absolute -right-[20%] top-[15%] h-[55vmax] w-[55vmax] rounded-full opacity-45 blur-[120px]"
        style={{
          animationDelay: '-9s',
          background:
            'radial-gradient(circle at 50% 50%, color-mix(in oklab, var(--accent) 60%, transparent), transparent 62%)',
        }}
      />
      <div
        className="animate-drift absolute -bottom-[35%] left-[25%] h-[60vmax] w-[60vmax] rounded-full opacity-35 blur-[130px]"
        style={{
          animationDelay: '-17s',
          background:
            'radial-gradient(circle at 50% 50%, color-mix(in oklab, var(--brand) 70%, transparent), transparent 60%)',
        }}
      />
      {/* Fine grain so the gradients never band on wide gamut displays. */}
      <div
        className="absolute inset-0 opacity-[0.035] mix-blend-overlay"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)'/%3E%3C/svg%3E\")",
        }}
      />
    </div>
  )
}
