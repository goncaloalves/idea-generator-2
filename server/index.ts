import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.ts';
import { DEFAULT_APP_SETTINGS, makeChat, mergeAppSettings, toPersisted, type AppSettings } from './providers.ts';
import { createEngine } from './engine.ts';
import { createAutopilot } from './autopilot.ts';
import { createHandler, type Runtime } from './app.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8300);
// Local first: loopback only. There is no login, and API keys pass through here.
const HOST = process.env.HOST ?? '127.0.0.1';

mkdirSync(join(root, 'data'), { recursive: true });
const repo = openDb(process.env.DB_FILE ?? join(root, 'data', 'ideas.db'));

// App settings: the browser owns them (localStorage) and pushes them here on
// load and on every change. API keys are kept in memory only and never written
// to disk; everything else (base URLs, models per role, budgets, projects root)
// is persisted to data/settings.json so a restart keeps the custom provider
// endpoint instead of dropping back to the defaults.
const SETTINGS_FILE = process.env.SETTINGS_FILE ?? join(root, 'data', 'settings.json');

function loadSettings(): AppSettings {
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
    return mergeAppSettings(raw, DEFAULT_APP_SETTINGS);
  } catch {
    return structuredClone(DEFAULT_APP_SETTINGS);
  }
}

function persistSettings(s: AppSettings) {
  try {
    const tmp = `${SETTINGS_FILE}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(toPersisted(s), null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, SETTINGS_FILE);
  } catch (e: any) {
    console.error('[settings] could not persist:', e?.message ?? e);
  }
}

let settings: AppSettings = loadSettings();
// False until a browser pushes its own settings. The persisted file already
// makes the server usable on its own, so autopilot runs straight after a boot.
let received = false;
const runtime: Runtime = {
  get: () => settings,
  set: (s) => {
    settings = s;
    received = true;
    persistSettings(s);
  },
  received: () => received,
};

const engine = createEngine({ repo, chat: makeChat(runtime.get), settings: runtime.get });
const autopilot = createAutopilot({ repo, engine, settings: runtime.get }).start();

createServer(createHandler({ repo, engine, autopilot, runtime, publicDir: join(root, 'public') })).listen(PORT, HOST, () => {
  console.log(`Idégeneratorn: http://localhost:${PORT}`);
  console.log(`settings: ${SETTINGS_FILE} (custom base: ${settings.baseUrls.custom || 'not set'})`);
  const auto = repo.listBoards().filter((b) => b.config.mode === 'auto');
  if (auto.length) console.log(`Autopilot on for ${auto.length} board(s); they need keys from the browser or the environment.`);
});
