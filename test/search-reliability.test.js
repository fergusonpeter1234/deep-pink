const { suite } = require('./support/harness')

suite('search fallback and recovery', async ({ check, subject }) => {
  const { builtInProviders, parseBingRss, SearchService } = subject
  const rss = `<rss version="2.0"><channel><item>
    <title>Public documentation &amp; updates</title>
    <link>https://example.org/docs?utm_source=search</link>
    <description>&lt;b&gt;Readable&lt;/b&gt; summary</description>
    </item><item><title>Unsafe</title><link>javascript:alert(1)</link></item>
    <item><title>Credentials</title><link>https://user:pass@example.org</link></item>
    </channel></rss>`
  const parsed = parseBingRss(rss)
  check('RSS preserves usable titles and summaries while rejecting unsafe links',
    parsed.length === 1 && parsed[0].title === 'Public documentation & updates' &&
    parsed[0].url === 'https://example.org/docs' && parsed[0].snippet === 'Readable summary')
  check('an HTML challenge cannot be mistaken for RSS results',
    parseBingRss('<html><body>Please verify you are human</body></html>').length === 0)

  for (const scenario of ['challenge', 'http-error', 'html-results']) {
    const requests = []
    const provider = builtInProviders(async (url) => {
      requests.push(new URL(url))
      if (url.searchParams.get('format') === 'rss') return rss
      if (scenario === 'http-error') throw new Error('HTTP 429')
      if (scenario === 'html-results') return '<ol id="b_results"><li class="b_algo"><h2><a href="https://example.org/docs">Documentation</a></h2></li></ol>'
      return '<html><body>Please verify you are human</body></html>'
    }).find((p) => p.id === 'bing')
    const results = await provider.search('fixture query', new AbortController().signal)
    check(`Bing ${scenario} returns usable results`, results.length === 1)
    check(`Bing ${scenario} only uses RSS when HTML fails`, scenario === 'html-results'
      ? requests.length === 1
      : requests.length === 2 && requests[1].searchParams.get('format') === 'rss' &&
        requests.every((url) => url.hostname === 'www.bing.com' && url.searchParams.get('q') === 'fixture query'))
  }

  const cancelled = new AbortController()
  let rssAfterCancellation = false
  const abortingBing = builtInProviders(async (url) => {
    if (url.searchParams.get('format') === 'rss') rssAfterCancellation = true
    cancelled.abort(new Error('Fixture cancellation'))
    throw cancelled.signal.reason
  }).find((p) => p.id === 'bing')
  let cancellation
  try { await abortingBing.search('fixture query', cancelled.signal) } catch (error) { cancellation = error }
  check('stopping a search does not launch an RSS fallback',
    cancellation === cancelled.signal.reason && !rssAfterCancellation)

  // A was healthy, so B is in cooldown. If A then fails, B must still be
  // eligible as a recovery fallback without waiting for that cooldown to expire.
  let nextQuery = false
  let recoveryCalls = 0
  const hit = { title: 'Public', url: 'https://example.org/docs', snippet: 'fixture' }
  const providers = [
    { id: 'a', name: 'A', async search() {
      if (nextQuery) throw new Error('HTTP 429')
      return [hit]
    } },
    { id: 'b', name: 'B', async search() {
      recoveryCalls++
      if (!nextQuery) throw new Error('HTTP 503')
      return [hit]
    } }
  ]
  const service = new SearchService({ now: () => 1000, hedgeMs: 0, mergeMs: 0 })
  await service.search({ query: 'first', limit: 2, providers, blockedDomains: [] })
  nextQuery = true
  const recovered = await service.search({ query: 'second', limit: 2, providers, blockedDomains: [] })
  check('an eligible source failing triggers a probe of a cooling fallback',
    recoveryCalls === 2 && recovered.results.length === 1 && recovered.results[0].sources.includes('B'))
  check('a recovered source is not reported as unavailable',
    recovered.unavailable.includes('A') && !recovered.unavailable.includes('B'))

  let failure
  try {
    await new SearchService().search({ query: 'fixture', limit: 1, blockedDomains: [], providers: [
      { id: 'blocked', name: 'Blocked', async search() { throw new Error('HTTP 429 private query must not appear') } },
      { id: 'empty', name: 'Empty', async search() { return [] } }
    ] })
  } catch (error) { failure = error.message }
  check('search errors distinguish HTTP blocking from empty results without leaking request details',
    failure.includes('Blocked (HTTP 429)') && failure.includes('Empty (no usable results or challenge)') &&
      !failure.includes('private query'))
})
