// App settings live in this browser (localStorage): API keys, provider
// addresses, the model for each role, the projects folder, the global budget
// and the autopilot defaults a new board starts from. They are pushed to the
// local server, which persists everything except the keys.

import { api } from './api.js';

const KEY = 'ideagen.settings.v1';
export const ROLES = ['distill', 'expand', 'combine', 'judge', 'summary', 'research', 'x', 'bsky', 'brief'];
export const PROVIDER_IDS = ['openrouter', 'anthropic', 'openai', 'azure', 'ollama', 'mlx', 'lmstudio', 'custom'];

const SONNET = 'openrouter:anthropic/claude-sonnet-5.5';
export const DEFAULTS = {
  keys: {},
  baseUrls: { ollama: 'http://localhost:11434', mlx: 'http://localhost:8080/v1', lmstudio: 'http://localhost:1234/v1', azure: '', custom: '' },
  models: { distill: SONNET, expand: SONNET, combine: SONNET, judge: SONNET, summary: SONNET, research: SONNET, x: 'openrouter:x-ai/grok-4.3', bsky: SONNET, brief: SONNET },
  projectsRoot: '~/Projekt/idea-projects',
  maxUsdPerDay: 5,
  autopilot: { mode: 'manual', seconds: 10, stepsPerHour: 60, usdPerDay: 1 },
};

export function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    /* corrupt: start from defaults */
  }
  return {
    keys: { ...DEFAULTS.keys, ...saved.keys },
    baseUrls: { ...DEFAULTS.baseUrls, ...saved.baseUrls },
    models: { ...DEFAULTS.models, ...saved.models },
    projectsRoot: saved.projectsRoot || DEFAULTS.projectsRoot,
    maxUsdPerDay: Number.isFinite(saved.maxUsdPerDay) ? saved.maxUsdPerDay : DEFAULTS.maxUsdPerDay,
    autopilot: { ...DEFAULTS.autopilot, ...(saved.autopilot && typeof saved.autopilot === 'object' ? saved.autopilot : {}) },
  };
}

/** Push to the server; returns provider status (which keys it has, where from). */
export function pushSettings(s) {
  return api('PUT', '/api/runtime-settings', s);
}

export async function saveSettings(s) {
  localStorage.setItem(KEY, JSON.stringify(s));
  return pushSettings(s);
}

/** Providers the current models depend on, so we can warn about a missing key. */
export function providersInUse(s) {
  return [...new Set(ROLES.map((r) => providerOf(s.models[r])))];
}

export function providerOf(ref = '') {
  const i = ref.indexOf(':');
  const head = i > 0 ? ref.slice(0, i) : '';
  return PROVIDER_IDS.includes(head) ? head : 'openrouter';
}
