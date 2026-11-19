/**
 * What a juror's web tools actually did, read from the provider's own response.
 *
 * Telemetry only: nothing here changes a score. The route returns one summary per
 * juror in model_results[].web_retrieval and logs it (WEB_RETRIEVAL), so an
 * operator or application can see whether a juror read anything before it voted.
 *
 * What each provider reports (recorded 2026-10-21, see
 * __tests__/unit/fixtures/web-retrieval/):
 *
 * - Anthropic pairs every server_tool_use with a result block. A web_fetch that
 *   returned the page is a web_fetch_result; one that did not is a
 *   web_fetch_tool_result_error with an error_code (url_not_allowed is the
 *   "You don't have permission to access this domain" the model quotes for
 *   wsj.com, marketwatch.com and api.nasdaq.com; url_not_accessible for cnbc.com;
 *   url_not_in_prior_context for a URL the model made up). So pages_opened
 *   counts pages whose content came back.
 * - OpenAI's Responses API lists web_search_call items with an action (search,
 *   open_page, find_in_page) and a status. Every open_page is "completed", also
 *   when the model then says the site answered 429 or robots.txt refused it, so
 *   pages_opened counts pages the model asked for, not pages it could read.
 *   page_errors_reported is false to say so.
 */

export interface WebRetrieval {
  /** 'on' when the answer came from a request with the provider's web tools. */
  web_tools: 'on' | 'off';
  /** Web searches that ran (Anthropic: results came back; OpenAI: search action completed). */
  searches: number;
  /** Pages opened (Anthropic: content came back; OpenAI: open_page completed; see page_errors_reported). */
  pages_opened: number;
  /** Page fetches the provider reported as failed, with its error code. */
  fetch_errors: Array<{ url: string; code: string }>;
  /** Searches the provider reported as failed, with its error code. */
  search_errors: Array<{ query: string; code: string }>;
  /** URLs of the pages counted in pages_opened, first occurrence order. */
  pages: string[];
  /** The search queries, in order. */
  queries: string[];
  /** false when the provider does not report a page that could not be read (OpenAI). */
  page_errors_reported: boolean;
  /** Why the web-tools request failed; the juror then answered without web access. */
  error?: string;
}

/** Passed in a provider's options by a caller that wants the summary of each call. */
export type WebRetrievalListener = (retrieval: WebRetrieval) => void;

/** Lists are capped so a runaway tool loop cannot bloat model_results (they reach IPFS). */
export const MAX_LISTED = 20;
const MAX_TEXT = 300;

export function webToolsOff(error?: string): WebRetrieval {
  return {
    web_tools: 'off',
    searches: 0,
    pages_opened: 0,
    fetch_errors: [],
    search_errors: [],
    pages: [],
    queries: [],
    page_errors_reported: true,
    ...(error ? { error: clip(error) } : {}),
  };
}

function webToolsOn(pageErrorsReported: boolean): WebRetrieval {
  return { ...webToolsOff(), web_tools: 'on', page_errors_reported: pageErrorsReported };
}

function clip(text: unknown): string {
  const value = typeof text === 'string' ? text : String(text ?? '');
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
}

function pushCapped<T>(list: T[], item: T): void {
  if (list.length < MAX_LISTED) list.push(item);
}

function addPage(summary: WebRetrieval, url: unknown): void {
  summary.pages_opened += 1;
  const value = clip(url);
  if (value && !summary.pages.includes(value)) pushCapped(summary.pages, value);
}

/**
 * Summary of Anthropic web_fetch / web_search use from the content blocks of every
 * turn of one request (pause_turn continuations included).
 */
export function summarizeAnthropicWebBlocks(content: unknown[]): WebRetrieval {
  const summary = webToolsOn(true);
  const calls = new Map<string, { name: string; input: any }>();
  const answered = new Set<string>();

  for (const block of content as any[]) {
    if (block?.type === 'server_tool_use' && typeof block.id === 'string') {
      calls.set(block.id, { name: block.name, input: block.input || {} });
      if (block.name === 'web_search') pushCapped(summary.queries, clip(block.input?.query));
    }
  }

  for (const block of content as any[]) {
    const call = calls.get(block?.tool_use_id);
    if (block?.type === 'web_fetch_tool_result') {
      answered.add(block.tool_use_id);
      const result = block.content || {};
      if (result.type === 'web_fetch_result') {
        addPage(summary, result.url || call?.input?.url);
      } else {
        pushCapped(summary.fetch_errors, { url: clip(call?.input?.url ?? result.url), code: clip(result.error_code || result.type || 'unknown') });
      }
    } else if (block?.type === 'web_search_tool_result') {
      answered.add(block.tool_use_id);
      if (Array.isArray(block.content)) {
        summary.searches += 1;
      } else {
        pushCapped(summary.search_errors, { query: clip(call?.input?.query), code: clip(block.content?.error_code || block.content?.type || 'unknown') });
      }
    }
  }

  // A tool call the response ended before answering (max_tokens, a cut-off turn).
  calls.forEach((call, id) => {
    if (answered.has(id)) return;
    if (call.name === 'web_fetch') pushCapped(summary.fetch_errors, { url: clip(call.input?.url), code: 'no_result' });
    if (call.name === 'web_search') pushCapped(summary.search_errors, { query: clip(call.input?.query), code: 'no_result' });
  });

  return summary;
}

/** Summary of the web_search_call items of one OpenAI Responses API result. */
export function summarizeOpenAIWebSearch(response: any): WebRetrieval {
  const summary = webToolsOn(false);
  for (const item of response?.output || []) {
    if (item?.type !== 'web_search_call') continue;
    const action = item.action || {};
    const status = typeof item.status === 'string' ? item.status : 'unknown';
    const completed = status === 'completed';
    if (action.type === 'search') {
      const queries: unknown[] = Array.isArray(action.queries) && action.queries.length > 0 ? action.queries : [action.query];
      queries.forEach(query => pushCapped(summary.queries, clip(query)));
      if (completed) summary.searches += 1;
      else pushCapped(summary.search_errors, { query: clip(queries[0]), code: status });
    } else if (action.type === 'open_page') {
      if (completed) addPage(summary, action.url);
      else pushCapped(summary.fetch_errors, { url: clip(action.url), code: status });
    }
    // find_in_page searches a page already opened; it adds no page or search.
  }
  return summary;
}

/** One summary for a juror called `count` times: sums, and lists in call order. */
export function mergeWebRetrievals(retrievals: WebRetrieval[]): WebRetrieval {
  if (retrievals.length === 0) return webToolsOff();
  if (retrievals.length === 1) return retrievals[0];
  const merged = webToolsOff();
  merged.web_tools = retrievals.some(r => r.web_tools === 'on') ? 'on' : 'off';
  merged.page_errors_reported = retrievals.every(r => r.page_errors_reported);
  for (const r of retrievals) {
    merged.searches += r.searches;
    merged.pages_opened += r.pages_opened;
    r.fetch_errors.forEach(e => pushCapped(merged.fetch_errors, e));
    r.search_errors.forEach(e => pushCapped(merged.search_errors, e));
    r.pages.forEach(p => { if (!merged.pages.includes(p)) pushCapped(merged.pages, p); });
    r.queries.forEach(q => pushCapped(merged.queries, q));
    if (r.error && !merged.error) merged.error = r.error;
  }
  return merged;
}

/** One log line: "on, 1 page, 0 searches, fetch errors: wsj.com url_not_allowed". */
export function describeWebRetrieval(r: WebRetrieval): string {
  if (r.web_tools === 'off') return r.error ? `off (web tools failed: ${r.error})` : 'off';
  const parts = [
    `${r.pages_opened} page${r.pages_opened === 1 ? '' : 's'} opened${r.page_errors_reported ? '' : ' (provider does not report unreadable pages)'}`,
    `${r.searches} search${r.searches === 1 ? '' : 'es'}`,
  ];
  if (r.fetch_errors.length) parts.push(`fetch errors: ${r.fetch_errors.map(e => `${hostOf(e.url)} ${e.code}`).join(', ')}`);
  if (r.search_errors.length) parts.push(`search errors: ${r.search_errors.map(e => e.code).join(', ')}`);
  return `on, ${parts.join(', ')}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
