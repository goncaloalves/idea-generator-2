// The lead panel: fresh material to seed a board with, aimed at the board's goal.
//
// X trends: Grok with OpenRouter's native web search, which can see X. The
// model writes the leads, but a lead is only kept if its URL is among the
// citations the SEARCH ENGINE returned, so we never show a post the model made up.
// (Measured 2026-11-02: 5 of 6 leads were cited, ~48 s and ~$0.04 per refresh.)
//
// AI research: Hugging Face's free paper APIs (today's trending papers plus a
// semantic search on the goal, last 12 months). An LLM picks the six most
// useful for the goal and writes a hook for each.
//
// Bluesky trends: the public app.bsky.feed.searchPosts endpoint. Unlike the X
// scout there is no model-side web search involved: we fetch real posts
// ourselves, so every lead is a URL that provably exists. The LLM only picks
// and rewrites the six most useful ones from that verified list.

import type { ChatFn, Lang } from './llm.ts';

export type LeadDraft = { title: string; summary: string; hook: string; url: string; meta: Record<string, unknown> };
type Paper = { id: string; title: string; summary: string; published: string; upvotes: number };

const LANG_NAME: Record<Lang, string> = { sv: 'idiomatic Swedish', en: 'English' };
const DEFAULT_TOPIC = 'new technology, AI tools, and new ways people actually use them';

const leadProps = {
  title: { type: 'string', description: 'Short title, 2–8 words.' },
  summary: { type: 'string', description: 'What is happening, 1–2 sentences, at most 40 words.' },
  hook: { type: 'string', description: 'One sentence: a new idea this could inspire for the goal.' },
};
const X_SCHEMA = {
  type: 'object',
  properties: {
    leads: {
      type: 'array',
      items: {
        type: 'object',
        properties: { ...leadProps, url: { type: 'string', description: 'The x.com URL of one real post you found.' } },
        required: ['title', 'summary', 'hook', 'url'],
        additionalProperties: false,
      },
    },
  },
  required: ['leads'],
  additionalProperties: false,
};
const RESEARCH_SCHEMA = {
  type: 'object',
  properties: {
    leads: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The paper id exactly as given in brackets.' }, ...leadProps },
        required: ['id', 'title', 'summary', 'hook'],
        additionalProperties: false,
      },
    },
  },
  required: ['leads'],
  additionalProperties: false,
};

const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

/** Compare URLs loosely: host without www, twitter.com = x.com, no query or trailing slash. */
export function normalizeUrl(u: string): string | null {
  try {
    const x = new URL(u);
    const host = x.hostname.toLowerCase().replace(/^www\./, '').replace(/^(mobile\.)?twitter\.com$/, 'x.com');
    return `${host}${x.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

export async function xLeads(a: { chat: ChatFn; model: string; goal: string; lang: Lang }) {
  const topic = a.goal.trim() || DEFAULT_TOPIC;
  const user = [
    `Search X for posts from the last 7 days that show emerging trends, new tools, behaviours or debates relevant to this goal:\n"${topic}"`,
    'Find 6 distinct trends. Each must come from a real post you found in the search results; give that post\'s x.com URL.',
    `Write title, summary and hook in ${LANG_NAME[a.lang]}.`,
  ].join('\n\n');
  const r = await a.chat({
    model: a.model,
    system: 'You are a trend scout. You only report what you actually found in the search results, never from memory.',
    user,
    schemaName: 'leads',
    schema: X_SCHEMA,
    temperature: 0.3,
    maxTokens: 3000,
    plugins: [{ id: 'web', engine: 'native', max_results: 12 }],
  });
  const cited = new Set((r.citations ?? []).map(normalizeUrl).filter(Boolean));
  const all: LeadDraft[] = (Array.isArray(r.value?.leads) ? r.value.leads : []).map((l: any) => ({
    title: clean(l.title, 120),
    summary: clean(l.summary, 400),
    hook: clean(l.hook, 300),
    url: clean(l.url, 500),
    meta: {},
  }));
  const leads = all.filter(
    (l) => l.title && /^https?:\/\/(www\.|mobile\.)?(x|twitter)\.com\//i.test(l.url) && cited.has(normalizeUrl(l.url)),
  );
  return { leads, dropped: all.length - leads.length, costUsd: r.costUsd };
}

const BSKY_SCHEMA = {
  type: 'object',
  properties: {
    leads: {
      type: 'array',
      items: {
        type: 'object',
        properties: { ...leadProps, id: { type: 'string', description: 'The post id exactly as given in brackets.' } },
        required: ['id', 'title', 'summary', 'hook'],
        additionalProperties: false,
      },
    },
  },
  required: ['leads'],
  additionalProperties: false,
};

type BskyPost = { id: string; url: string; text: string; handle: string; createdAt: string; likes: number; reposts: number };

/** Turn an at:// URI plus author handle into a normal bsky.app permalink. */
export function bskyPermalink(uri: string, handle: string): string | null {
  const m = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/?#]+)$/.exec(uri ?? '');
  if (!m || !handle) return null;
  return `https://bsky.app/profile/${handle}/post/${m[2]}`;
}

const BSKY_STOPWORDS = new Set([
  'the','and','with','for','that','this','from','have','must','into','your','they','them','their','there','which','while','about','over','under','each','every','only','also','than','then','when','what','where','will','would','should','could','can','not','but','out','one','two','any','all','are','was','were','been','being','has','had','its','his','her','our','you','who','how','why','per','via','use','using','used','make','made','able','easily','easy','hard','产品'
]);

/**
 * Bluesky full-text search is keyword based: a whole goal paragraph matches
 * nothing. Turn the goal into a handful of short candidate queries, most
 * specific first, and let the caller try them in order.
 */
export function bskyQueryCandidates(goal: string, focus = ''): string[] {
  const out: string[] = [];
  const push = (q: string) => {
    const v = q.trim().replace(/\s+/g, ' ').slice(0, 100);
    if (v && v.length >= 3 && !out.includes(v)) out.push(v);
  };

  // An explicit focus is already a short phrase written for this purpose.
  if (focus.trim() && focus.trim().length <= 80) push(focus);

  const words = goal
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !BSKY_STOPWORDS.has(w));

  // Two-word phrases beat single words for relevance on this endpoint.
  for (let i = 0; i + 1 < words.length && out.length < 6; i++) {
    if (words[i] !== words[i + 1]) push(`${words[i]} ${words[i + 1]}`);
  }
  for (const w of words) {
    if (out.length >= 10) break;
    push(w);
  }

  if (!out.length) push(DEFAULT_TOPIC);
  return out.slice(0, 10);
}

/**
 * Bluesky has no model-side live search, so we fetch real posts ourselves and
 * hand the verified list to the model to pick from. Every lead URL therefore
 * provably exists, unlike the X scout which depends on the citations coming back.
 */
export async function fetchBskyPosts(goal: string, fetchFn: typeof fetch = fetch, limit = 40, focus = ''): Promise<BskyPost[]> {
  const weekAgo = Date.now() - 7 * 86_400_000;
  const seen = new Set<string>();
  const out: BskyPost[] = [];
  const errors: string[] = [];

  for (const q of bskyQueryCandidates(goal, focus)) {
    if (out.length >= 12) break;
    const url = `https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&limit=${Math.min(limit, 100)}&sort=latest`;
    let data: any;
    try {
      const res = await fetchFn(url, {
        signal: AbortSignal.timeout(20_000),
        headers: { Accept: 'application/json', 'User-Agent': 'idea-generator-2/0.1.0' },
      });
      if (!res.ok) {
        errors.push(`${q}: HTTP ${res.status}`);
        continue;
      }
      data = await res.json();
    } catch (e: any) {
      errors.push(`${q}: ${e?.message ?? String(e)}`);
      continue;
    }
    for (const p of Array.isArray(data?.posts) ? data.posts : []) {
      const handle = p?.author?.handle;
      const link = bskyPermalink(String(p?.uri ?? ''), String(handle ?? ''));
      const text = String(p?.record?.text ?? '').replace(/\s+/g, ' ').trim();
      if (!link || !text || text.length < 40 || seen.has(link)) continue;
      const created = String(p?.record?.createdAt ?? p?.indexedAt ?? '');
      if (created && Date.parse(created) < weekAgo) continue;
      seen.add(link);
      out.push({
        id: String(p.uri),
        url: link,
        text: text.slice(0, 500),
        handle: String(handle ?? ''),
        createdAt: created,
        likes: Number(p?.likeCount) || 0,
        reposts: Number(p?.repostCount) || 0,
      });
    }
  }

  if (!out.length && errors.length) throw new Error(`Bluesky search failed (${errors.slice(0, 3).join('; ')})`);
  // Engagement first: a post people argued with is a better trend signal than noise.
  return out.sort((a, b) => b.likes + b.reposts - (a.likes + a.reposts));
}

export async function bskyLeads(a: { chat: ChatFn; model: string; goal: string; lang: Lang; posts: BskyPost[] }) {
  if (!a.posts.length) throw new Error('Bluesky returned no recent posts for this goal');
  const byId = new Map(a.posts.map((p) => [p.id, p]));
  const list = a.posts
    .slice(0, 60)
    .map((p) => `[${p.id}] @${p.handle} (${p.likes} likes, ${p.reposts} reposts): ${p.text.slice(0, 320)}`)
    .join('\n');
  const aim = a.goal.trim() ? `the board's goal: "${a.goal.trim()}"` : DEFAULT_TOPIC;
  const user = [
    `Pick the 6 posts below that best show emerging trends, new tools, behaviours or complaints relevant to ${aim}.`,
    'For each: the id exactly as given in brackets, a plain-language title (no jargon), a summary of what is being said or asked, and a hook: one idea it could inspire for the goal.',
    'Prefer posts with real signal (people describing what they built, bought, paid for, or gave up on) over vague commentary.',
    `Write title, summary and hook in ${LANG_NAME[a.lang]}.`,
    `Posts:\n${list}`,
  ].join('\n\n');
  const r = await a.chat({
    model: a.model,
    system: 'You are a trend scout reading real Bluesky posts. You only report what these posts actually say, never from memory.',
    user,
    schemaName: 'leads',
    schema: BSKY_SCHEMA,
    temperature: 0.3,
    maxTokens: 2500,
  });
  const leads: LeadDraft[] = [];
  for (const l of Array.isArray(r.value?.leads) ? r.value.leads : []) {
    const p = byId.get(String(l.id).replace(/^\[|\]$/g, ''));
    if (!p || leads.some((x) => x.meta.postId === p.id)) continue;
    leads.push({
      title: clean(l.title, 120) || p.text.slice(0, 80),
      summary: clean(l.summary, 400),
      hook: clean(l.hook, 300),
      url: p.url,
      meta: { postId: p.id, handle: p.handle, published: p.createdAt.slice(0, 10), likes: p.likes, reposts: p.reposts },
    });
  }
  return { leads, costUsd: r.costUsd };
}

function toPaper(raw: any): Paper | null {
  const p = raw?.paper ?? raw;
  if (!p?.id || !p?.title) return null;
  return {
    id: String(p.id),
    title: String(p.title).replace(/\s+/g, ' ').trim(),
    summary: String(p.ai_summary || p.summary || raw.summary || '').replace(/\s+/g, ' ').trim(),
    published: String(p.publishedAt || raw.publishedAt || ''),
    upvotes: Number(p.upvotes) || 0,
  };
}

export async function fetchPapers(goal: string, fetchFn: typeof fetch = fetch): Promise<Paper[]> {
  const get = async (url: string) => {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Hugging Face ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  };
  const [daily, searched] = await Promise.all([
    get('https://huggingface.co/api/daily_papers?limit=60').catch(() => []),
    goal.trim()
      ? get(`https://huggingface.co/api/papers/search?q=${encodeURIComponent(goal.trim().slice(0, 200))}&limit=30`).catch(() => [])
      : Promise.resolve([]),
  ]);
  const yearAgo = Date.now() - 365 * 86_400_000;
  const recent = (p: Paper) => !p.published || Date.parse(p.published) >= yearAgo;
  const seen = new Set<string>();
  const out: Paper[] = [];
  // Goal matches first: they are what the scout should look at most closely.
  for (const p of [...searched.map(toPaper).filter((p) => p && recent(p)), ...daily.map(toPaper)] as (Paper | null)[]) {
    if (p && !seen.has(p.id)) {
      seen.add(p.id);
      out.push(p);
    }
  }
  return out;
}

export async function researchLeads(a: { chat: ChatFn; model: string; goal: string; lang: Lang; papers: Paper[] }) {
  if (!a.papers.length) throw new Error('Hugging Face returned no papers');
  const byId = new Map(a.papers.map((p) => [p.id, p]));
  const list = a.papers
    .slice(0, 80)
    .map((p) => `[${p.id}] ${p.title} (${p.published.slice(0, 10)}, ${p.upvotes} upvotes): ${p.summary.slice(0, 280)}`)
    .join('\n');
  const aim = a.goal.trim()
    ? `the board's goal: "${a.goal.trim()}"`
    : 'new products, services or experiences (the board has no goal yet)';
  const user = [
    `Pick the 6 papers below that could most inspire new ideas for ${aim}. Prefer recent, concrete results that make something newly possible. Skip papers that only improve a benchmark score.`,
    'For each: the id exactly as given, a plain-language title (no jargon), a summary of what the research makes possible, and a hook: one idea it could inspire for the goal.',
    `Write title, summary and hook in ${LANG_NAME[a.lang]}.`,
    `Papers:\n${list}`,
  ].join('\n\n');
  const r = await a.chat({
    model: a.model,
    system: 'You are a research scout who reads AI papers and explains to designers and founders what each one makes possible.',
    user,
    schemaName: 'research',
    schema: RESEARCH_SCHEMA,
    temperature: 0.4,
    maxTokens: 2500,
  });
  const leads: LeadDraft[] = [];
  for (const l of Array.isArray(r.value?.leads) ? r.value.leads : []) {
    const p = byId.get(String(l.id).replace(/^\[|\]$/g, ''));
    if (!p || leads.some((x) => x.meta.paperId === p.id)) continue; // unknown or repeated id: drop
    leads.push({
      title: clean(l.title, 120) || p.title,
      summary: clean(l.summary, 400),
      hook: clean(l.hook, 300),
      url: `https://huggingface.co/papers/${p.id}`,
      meta: { paperId: p.id, paperTitle: p.title, published: p.published.slice(0, 10), upvotes: p.upvotes },
    });
  }
  return { leads, costUsd: r.costUsd };
}
