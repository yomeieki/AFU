const cache = new Map<string, { quotes: unknown; at: number }>()
export function clearExpressQuoteCache(): void { cache.clear() }
export const _quoteCache = cache
