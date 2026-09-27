import { isForbiddenRequestHeader } from './http'

/**
 * Request headers people commonly add to a download. Browser-controlled
 * ("forbidden") headers are deliberately left out — a page cannot set them, so
 * suggesting them would only lead to a validation error.
 */
const CANDIDATES = [
  'Accept',
  'Accept-Language',
  'Authorization',
  'Cache-Control',
  'Content-Type',
  'If-Match',
  'If-Modified-Since',
  'If-None-Match',
  'If-Range',
  'If-Unmodified-Since',
  'Pragma',
  'Priority',
  'Range',
  'User-Agent',
  'X-Api-Key',
  'X-Auth-Token',
  'X-Client-Id',
  'X-CSRF-Token',
  'X-Correlation-Id',
  'X-Forwarded-For',
  'X-Request-Id',
  'X-Requested-With',
]

export const COMMON_REQUEST_HEADERS: readonly string[] = CANDIDATES.filter((name) => !isForbiddenRequestHeader(name))

/**
 * Case-insensitive filter. Prefix matches come first, then substring matches.
 * An empty query returns every suggestion.
 */
export function filterHeaderSuggestions(query: string, list: readonly string[] = COMMON_REQUEST_HEADERS): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...list]
  const prefix: string[] = []
  const contains: string[] = []
  for (const name of list) {
    const lower = name.toLowerCase()
    if (lower.startsWith(q)) prefix.push(name)
    else if (lower.includes(q)) contains.push(name)
  }
  return [...prefix, ...contains]
}
