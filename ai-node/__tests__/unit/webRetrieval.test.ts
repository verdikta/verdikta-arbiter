import {
  MAX_LISTED,
  STALE_PAGE_SECONDS,
  describeWebRetrieval,
  mergeWebRetrievals,
  summarizeAnthropicWebBlocks,
  summarizeOpenAIWebSearch,
  webToolsOff,
} from '../../src/lib/llm/web-retrieval';
import anthropicCanary from './fixtures/web-retrieval/anthropic-canary-2026-10-21.json';
import openaiCanary from './fixtures/web-retrieval/openai-canary-2026-10-21.json';

// Recorded 2026-10-21: the node's exact web-tools requests for the question-wager canary
// (~/projects/verdikta/tmp/question-wager-canary-2026-10-21). Part A asks each juror to read
// MSFT's 10/20 close from one finance page; its REPORT.md has which pages each juror could read.
const claudeBlocks = (id: string) =>
  (anthropicCanary.cases as Record<string, { turns: Array<{ content: unknown[] }> }>)[id].turns.flatMap(t => t.content);
const gptResponse = (id: string) =>
  (openaiCanary.cases as Record<string, { response: unknown }>)[id].response;

describe('summarizeAnthropicWebBlocks (recorded claude-sonnet-5 responses)', () => {
  // The canary's readability table for claude-sonnet-5. Unreadable pages come back as
  // fetch errors with Anthropic's code; url_not_allowed is the "You don't have permission
  // to access this domain" Claude quotes in its justification.
  test.each([
    ['S2-wsj', 0, 0, [['https://www.wsj.com/market-data/quotes/MSFT/historical-prices', 'url_not_allowed'], ['https://www.wsj.com/market-data/quotes/MSFT/historical-prices/download', 'url_not_in_prior_context']]],
    ['S6-marketwatch', 0, 1, [['https://www.marketwatch.com/investing/stock/msft/download-data', 'url_not_allowed'], ['https://www.marketwatch.com/investing/stock/msft/downloaddata', 'url_not_in_prior_context']]],
    ['S10-nasdaq-api', 0, 0, [['https://api.nasdaq.com/api/quote/MSFT/historical?assetclass=stocks&fromdate=2026-10-14&todate=2026-10-21&limit=10', 'url_not_allowed']]],
    ['S3-reuters', 0, 0, [['https://www.reuters.com/markets/companies/MSFT.OQ/', 'url_not_allowed'], ['https://www.reuters.com/markets/companies/MSFT.OQ/', 'url_not_allowed'], ['https://www.reuters.com/markets/companies/MSFT.OQ', 'url_not_allowed']]],
    ['S8-cnbc', 0, 0, [['https://www.cnbc.com/quotes/MSFT', 'url_not_accessible'], ['https://www.cnbc.com/quotes/MSFT', 'url_not_accessible']]],
    ['S7-stockanalysis', 1, 0, []],
    ['S9-investing', 1, 1, []],
    ['S4-yahoo', 1, 0, []],
    ['S5-google', 1, 0, []],
    // A JavaScript page: the fetch returns the page shell (no price table). Counted as opened:
    // the summary shows that something was read, not that it was the right thing.
    ['S1-nasdaq', 2, 0, []],
  ])('%s: %i page(s) opened, %i search(es), fetch errors as Anthropic reported them', (id, pages, searches, errors) => {
    const r = summarizeAnthropicWebBlocks(claudeBlocks(id as string));
    expect(r.web_tools).toBe('on');
    expect(r.page_errors_reported).toBe(true);
    expect(r.pages_opened).toBe(pages);
    expect(r.searches).toBe(searches);
    expect(r.fetch_errors).toEqual((errors as string[][]).map(([url, code]) => ({ url, code })));
    expect(r.search_errors).toEqual([]);
  });

  test('pages lists each opened URL once', () => {
    expect(summarizeAnthropicWebBlocks(claudeBlocks('S1-nasdaq')).pages).toEqual([
      'https://www.nasdaq.com/market-activity/stocks/msft/historical',
    ]);
  });

  test('queries keep what Claude searched for, including its "placeholder" search', () => {
    expect(summarizeAnthropicWebBlocks(claudeBlocks('S9-investing')).queries).toEqual(['placeholder']);
  });

  test('parallel tool calls are paired with their results by tool_use_id (Q6: 3 searches, 1 page, 1 error)', () => {
    const r = summarizeAnthropicWebBlocks(claudeBlocks('Q6-minute-clear-yes'));
    expect(r).toMatchObject({ searches: 3, pages_opened: 1, pages: ['https://stockanalysis.com/stocks/msft/history/'] });
    expect(r.fetch_errors).toEqual([{ url: 'https://stooq.com/q/d/l/?s=msft.us&d1=20261020&d2=20261020&i=5', code: 'url_not_in_prior_context' }]);
    expect(r.queries).toHaveLength(3);
  });

  test('a search error and a tool call left without a result are reported', () => {
    const r = summarizeAnthropicWebBlocks([
      { type: 'server_tool_use', id: 'a', name: 'web_search', input: { query: 'msft close' } },
      { type: 'web_search_tool_result', tool_use_id: 'a', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
      { type: 'server_tool_use', id: 'b', name: 'web_fetch', input: { url: 'https://example.com/x' } },
      { type: 'text', text: 'cut off' },
    ]);
    expect(r.searches).toBe(0);
    expect(r.search_errors).toEqual([{ query: 'msft close', code: 'max_uses_exceeded' }]);
    expect(r.fetch_errors).toEqual([{ url: 'https://example.com/x', code: 'no_result' }]);
  });

  test('no tool blocks: web tools were on but nothing was retrieved', () => {
    expect(summarizeAnthropicWebBlocks([{ type: 'text', text: '{"score":[1000000,0]}' }])).toMatchObject({
      web_tools: 'on', searches: 0, pages_opened: 0, fetch_errors: [], search_errors: [],
    });
  });
});

describe('summarizeOpenAIWebSearch (recorded gpt-5.6-terra responses)', () => {
  // OpenAI marks every open_page "completed", including the pages GPT then says it could not
  // read (Yahoo: HTTP 429; CNBC: robots.txt; Reuters: not opened). So pages_opened counts pages
  // GPT asked for, and page_errors_reported is false.
  test.each(['S2-wsj', 'S6-marketwatch', 'S10-nasdaq-api', 'S7-stockanalysis', 'S9-investing', 'S4-yahoo', 'S8-cnbc', 'S3-reuters', 'S1-nasdaq', 'S5-google'])(
    '%s: one open_page, completed, no error reported',
    id => {
      const r = summarizeOpenAIWebSearch(gptResponse(id));
      expect(r).toMatchObject({ web_tools: 'on', pages_opened: 1, searches: 0, fetch_errors: [], page_errors_reported: false });
      expect(r.pages).toHaveLength(1);
    }
  );

  test('searches and their queries are counted (G1: 2 searches, 4 queries, 1 page)', () => {
    const r = summarizeOpenAIWebSearch(gptResponse('G1-ecb-fx-yes'));
    expect(r).toMatchObject({ searches: 2, pages_opened: 1 });
    expect(r.queries).toHaveLength(4);
    expect(r.queries[0]).toBe('site:ecb.europa.eu euro foreign exchange reference rates 20 October 2026 USD');
    expect(r.pages).toEqual(['https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/eurofxref-graph-usd.en.html']);
  });

  test('a call that did not complete is reported with its status', () => {
    const r = summarizeOpenAIWebSearch({
      output: [
        { type: 'web_search_call', status: 'failed', action: { type: 'open_page', url: 'https://example.com/a' } },
        { type: 'web_search_call', status: 'failed', action: { type: 'search', query: 'q1' } },
        { type: 'web_search_call', status: 'completed', action: { type: 'find_in_page', url: 'https://example.com/a', pattern: 'Close' } },
        { type: 'message', content: [{ type: 'output_text', text: '{}' }] },
      ],
    });
    expect(r).toMatchObject({ searches: 0, pages_opened: 0 });
    expect(r.fetch_errors).toEqual([{ url: 'https://example.com/a', code: 'failed' }]);
    expect(r.search_errors).toEqual([{ query: 'q1', code: 'failed' }]);
  });

  test('a response without web_search_call items retrieved nothing', () => {
    expect(summarizeOpenAIWebSearch({ output: [{ type: 'message', content: [] }] })).toMatchObject({ web_tools: 'on', searches: 0, pages_opened: 0 });
  });
});

describe('mergeWebRetrievals, webToolsOff and describeWebRetrieval', () => {
  test('no calls reported: off', () => {
    expect(mergeWebRetrievals([])).toEqual(webToolsOff());
  });

  test('two calls (count 2) add up; pages are listed once', () => {
    const a = summarizeAnthropicWebBlocks(claudeBlocks('S7-stockanalysis'));
    const b = summarizeAnthropicWebBlocks(claudeBlocks('Q3-close-near-yes'));
    const merged = mergeWebRetrievals([a, b]);
    expect(merged).toMatchObject({ web_tools: 'on', pages_opened: 3, searches: 1, page_errors_reported: true });
    expect(merged.pages).toEqual(['https://stockanalysis.com/stocks/msft/history/', 'https://www.investing.com/equities/microsoft-corp-historical-data']);
  });

  test('one call with tools and one without: on, and page_errors_reported only if every call reports them', () => {
    const merged = mergeWebRetrievals([summarizeOpenAIWebSearch(gptResponse('S2-wsj')), webToolsOff('400 tool not available')]);
    expect(merged).toMatchObject({ web_tools: 'on', pages_opened: 1, page_errors_reported: false, error: '400 tool not available' });
  });

  test('lists are capped', () => {
    const blocks: unknown[] = [];
    for (let i = 0; i < MAX_LISTED + 5; i++) {
      blocks.push({ type: 'server_tool_use', id: `f${i}`, name: 'web_fetch', input: { url: `https://example.com/${i}` } });
      blocks.push({ type: 'web_fetch_tool_result', tool_use_id: `f${i}`, content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' } });
    }
    const r = summarizeAnthropicWebBlocks(blocks);
    expect(r.fetch_errors).toHaveLength(MAX_LISTED);
  });

  test('log lines', () => {
    expect(describeWebRetrieval(summarizeAnthropicWebBlocks(claudeBlocks('S2-wsj')))).toBe(
      'on, 0 pages opened, 0 searches, fetch errors: www.wsj.com url_not_allowed, www.wsj.com url_not_in_prior_context'
    );
    expect(describeWebRetrieval(summarizeOpenAIWebSearch(gptResponse('S4-yahoo')))).toBe(
      'on, 1 page opened (provider does not report unreadable pages), 0 searches'
    );
    expect(describeWebRetrieval(webToolsOff())).toBe('off');
    expect(describeWebRetrieval(webToolsOff('400 tool not available'))).toBe('off (web tools failed: 400 tool not available)');
  });
});

describe('page_times and stale_pages (when each fetched copy was retrieved)', () => {
  // The canary's Claude requests were sent with the cached web_fetch_20250910 at about
  // 18:05Z on 2026-10-21 (the newest retrieved_at in the fixture is 18:04:29Z). Several
  // pages came back as copies retrieved hours or days earlier.
  const requestedAt = new Date('2026-10-21T18:05:00Z');

  test.each([
    ['S5-google', [['https://www.google.com/finance/quote/MSFT:NASDAQ', '2026-10-21T18:04:29+00:00', 31]], 0],
    ['S7-stockanalysis', [['https://stockanalysis.com/stocks/msft/history/', '2026-10-21T16:44:14+00:00', 4846]], 1],
    ['S4-yahoo', [['https://finance.yahoo.com/quote/MSFT/history/', '2026-10-21T07:38:33+00:00', 37587]], 1],
    ['S9-investing', [['https://www.investing.com/equities/microsoft-corp-historical-data', '2026-10-20T22:47:09+00:00', 69471]], 1],
    ['S1-nasdaq', [
      ['https://www.nasdaq.com/market-activity/stocks/msft/historical', '2026-10-19T20:50:47+00:00', 162853],
      ['https://www.nasdaq.com/market-activity/stocks/msft/historical', '2026-10-19T20:50:47+00:00', 162853],
    ], 2],
  ])('%s: retrieved_at and age per fetch; %#', (id, times, stale) => {
    const r = summarizeAnthropicWebBlocks(claudeBlocks(id as string), { requestedAt });
    expect(r.page_times).toEqual((times as Array<[string, string, number]>).map(([url, retrieved_at, age_seconds]) => ({ url, retrieved_at, age_seconds })));
    expect(r.stale_pages).toBe(stale);
    expect(r.page_times_reported).toBe(true);
  });

  test('an hour is the line: older copies are stale', () => {
    const at = (secondsBefore: number) => new Date(requestedAt.getTime() - secondsBefore * 1000).toISOString();
    const blocks = [STALE_PAGE_SECONDS, STALE_PAGE_SECONDS + 1].flatMap((age, i) => [
      { type: 'server_tool_use', id: `f${i}`, name: 'web_fetch', input: { url: `https://example.com/${i}` } },
      { type: 'web_fetch_tool_result', tool_use_id: `f${i}`, content: { type: 'web_fetch_result', url: `https://example.com/${i}`, retrieved_at: at(age) } },
    ]);
    const r = summarizeAnthropicWebBlocks(blocks, { requestedAt });
    expect(r.page_times.map(t => t.age_seconds)).toEqual([STALE_PAGE_SECONDS, STALE_PAGE_SECONDS + 1]);
    expect(r.stale_pages).toBe(1);
  });

  test('without the request time the ages are unknown and nothing is counted stale', () => {
    const r = summarizeAnthropicWebBlocks(claudeBlocks('S9-investing'));
    expect(r.page_times).toEqual([{ url: 'https://www.investing.com/equities/microsoft-corp-historical-data', retrieved_at: '2026-10-20T22:47:09+00:00', age_seconds: null }]);
    expect(r.stale_pages).toBe(0);
    expect(r).not.toHaveProperty('fetch_cache');
  });

  test('fetch_cache records whether cached copies were allowed', () => {
    expect(summarizeAnthropicWebBlocks(claudeBlocks('S7-stockanalysis'), { fetchCache: 'bypassed' }).fetch_cache).toBe('bypassed');
    expect(summarizeAnthropicWebBlocks(claudeBlocks('S7-stockanalysis'), { fetchCache: 'allowed' }).fetch_cache).toBe('allowed');
  });

  test('OpenAI does not say when a page was retrieved', () => {
    const r = summarizeOpenAIWebSearch(gptResponse('S9-investing'));
    expect(r).toMatchObject({ page_times: [], page_times_reported: false, stale_pages: 0 });
    expect(r).not.toHaveProperty('fetch_cache');
  });

  test('merged: times listed in call order, stale copies added up, any allowed cache reported', () => {
    const a = summarizeAnthropicWebBlocks(claudeBlocks('S9-investing'), { requestedAt, fetchCache: 'bypassed' });
    const b = summarizeAnthropicWebBlocks(claudeBlocks('S5-google'), { requestedAt, fetchCache: 'allowed' });
    const merged = mergeWebRetrievals([a, b]);
    expect(merged.page_times.map(t => t.url)).toEqual([
      'https://www.investing.com/equities/microsoft-corp-historical-data',
      'https://www.google.com/finance/quote/MSFT:NASDAQ',
    ]);
    expect(merged).toMatchObject({ stale_pages: 1, page_times_reported: true, fetch_cache: 'allowed' });
    expect(mergeWebRetrievals([a, summarizeOpenAIWebSearch(gptResponse('S2-wsj'))])).toMatchObject({ page_times_reported: false, fetch_cache: 'bypassed' });
  });

  test('log line names each stale copy and its age', () => {
    expect(describeWebRetrieval(summarizeAnthropicWebBlocks(claudeBlocks('S9-investing'), { requestedAt }))).toBe(
      'on, 1 page opened, 1 search, 1 stale copy: www.investing.com 19.3 h old'
    );
    expect(describeWebRetrieval(summarizeAnthropicWebBlocks(claudeBlocks('S1-nasdaq'), { requestedAt }))).toBe(
      'on, 2 pages opened, 0 searches, 2 stale copies: www.nasdaq.com 1.9 d old, www.nasdaq.com 1.9 d old'
    );
    expect(describeWebRetrieval(summarizeAnthropicWebBlocks(claudeBlocks('S5-google'), { requestedAt }))).toBe('on, 1 page opened, 0 searches');
  });
});
