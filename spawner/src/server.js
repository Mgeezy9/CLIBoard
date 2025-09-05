import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import Docker from 'dockerode';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

const PORT = parseInt(process.env.PORT || '8080', 10);
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const IMAGE = process.env.CLI_RUNNER_IMAGE || 'cli-runner:latest';
const IDLE_TIMEOUT_SEC = parseInt(process.env.IDLE_TIMEOUT_SEC || '900', 10); // 15m default; 0 disables
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const defaultWorkRoot = path.resolve(REPO_ROOT, 'cli-runner/volumes/workspace');
const defaultCredsRoot = path.resolve(REPO_ROOT, 'cli-runner/volumes/creds');
const ALLOW_WORKSPACE_ROOTS = (process.env.ALLOW_WORKSPACE_ROOTS || defaultWorkRoot)
  .split(',')
  .map((p) => path.resolve(p.trim()))
  .filter(Boolean);
const ALLOW_CREDS_ROOTS = (process.env.ALLOW_CREDS_ROOTS || defaultCredsRoot)
  .split(',')
  .map((p) => path.resolve(p.trim()))
  .filter(Boolean);

const docker = new Docker();
const bus = new EventEmitter();
const eventClients = new Set();

const ENGINES = new Set(['codex', 'gemini', 'opencode']);

function nowIso() { return new Date().toISOString(); }
function tsForFile() { return new Date().toISOString().replace(/[:.]/g, '-'); }

function isSubPath(child, parent) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isAllowed(p, allowedRoots) {
  const abs = path.resolve(p);
  for (const root of allowedRoots) {
    if (abs === root || isSubPath(abs, root)) return true;
  }
  return false;
}

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

function labelsForWarm({ engine, workspace, creds, readOnly, uidgid }) {
  return {
    'adz.warm': 'true',
    'adz.engine': engine,
    'adz.workspace': workspace,
    'adz.creds': creds,
    'adz.readonly': readOnly ? '1' : '0',
    'adz.uidgid': uidgid || '',
  };
}

async function findWarmContainer({ engine, workspace, creds, readOnly, uidgid }) {
  const filters = {
    label: [
      'adz.warm=true',
      `adz.engine=${engine}`,
      `adz.workspace=${workspace}`,
      `adz.creds=${creds}`,
      `adz.readonly=${readOnly ? '1' : '0'}`,
      `adz.uidgid=${uidgid || ''}`,
    ]
  };
  const list = await docker.listContainers({ all: true, filters });
  const running = list.find(c => c.State === 'running');
  if (!running) return null;
  return docker.getContainer(running.Id);
}

async function ensureWarmContainer({ engine, workspace, creds, readOnly, uidgid }) {
  const existing = await findWarmContainer({ engine, workspace, creds, readOnly, uidgid });
  if (existing) {
    const info = await existing.inspect();
    return { id: existing.id, name: info.Name?.slice(1) || existing.id.substring(0,12) };
  }
  const name = `adz-warm-${engine}-${tsForFile()}`;
  const HostConfig = {
    AutoRemove: false,
    Binds: [ `${workspace}:/workspace:rw`, `${creds}:/home/agent/.creds:rw` ],
    ...(readOnly ? { ReadonlyRootfs: true, Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=256m' } } : {}),
  };
  const Labels = labelsForWarm({ engine, workspace, creds, readOnly, uidgid });
  const createOpts = {
    name,
    Image: IMAGE,
    Tty: true,
    OpenStdin: false,
    AttachStdout: false,
    AttachStderr: false,
    Env: ['TERM=xterm-256color'],
    WorkingDir: '/workspace',
    HostConfig,
    Labels,
    Entrypoint: ['bash', '-lc', 'sleep infinity'],
  };
  if (uidgid) createOpts.User = uidgid;
  const container = await docker.createContainer(createOpts);
  await container.start();
  return { id: container.id, name };
}

async function listAdzContainers() {
  const list = await docker.listContainers({ all: true });
  return list.filter((c) => c.Labels && (c.Labels['adz.engine'] || c.Labels['adz.warm']));
}

// In-memory run registry
const runs = new Map(); // runId -> { id, engine, workspace, creds, containerId, containerName, startedAt, status, transcriptPath, listeners: Set<res>, attachStream }

async function resolveStatus(container) {
  const info = await container.inspect();
  return info.State.Running ? 'running' : (info.State.Status || 'exited');
}

function createSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
}

function sseSend(res, data) {
  // split into lines for SSE framing
  const lines = (typeof data === 'string' ? data : data.toString('utf8')).split(/\n/);
  for (let i = 0; i < lines.length; i++) {
    res.write(`data: ${lines[i]}\n`);
  }
  res.write('\n');
}

function eventsBroadcast(event, payload) {
  const line = JSON.stringify({ event, ts: nowIso(), ...payload });
  for (const res of eventClients) {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${line}\n\n`);
    } catch (_) {}
  }
}

function detectArtifactsFromLine(run, line) {
  const events = [];
  // URLs
  const urlRegex = /(https?:\/\/[^\s]+)\b/g;
  let m;
  while ((m = urlRegex.exec(line)) !== null) {
    const url = m[1];
    let kind = 'url';
    if (/github\.com\/[^\/]+\/[^\/]+\/pull\//i.test(url)) kind = 'pr';
    events.push({ type: 'artifact', kind, url });
  }
  // File paths under /workspace
  const fileRegex = /(\/workspace\/[\w\-\/\.]+\w)/g;
  while ((m = fileRegex.exec(line)) !== null) {
    const p = m[1];
    events.push({ type: 'artifact', kind: 'file', path: p });
  }
  // Auth-like errors
  if (/invalid\s*(api\s*)?key|unauthorized|401|permission\s*denied|UNAUTHENTICATED/i.test(line)) {
    events.push({ type: 'warning', kind: 'auth', message: line.trim() });
  }
  return events;
}

async function startRun({ engine, workspace, creds, readOnly, uidgid, extraEnv, preferWarm = true, argv = [] }) {
  if (!ENGINES.has(engine)) throw new Error(`Invalid engine: ${engine}`);
  if (!path.isAbsolute(workspace)) throw new Error('workspace must be an absolute path');
  if (!path.isAbsolute(creds)) throw new Error('creds must be an absolute path');
  if (!isAllowed(workspace, ALLOW_WORKSPACE_ROOTS)) throw new Error('workspace not under allowed roots');
  if (!isAllowed(creds, ALLOW_CREDS_ROOTS)) throw new Error('creds not under allowed roots');

  // Ensure .runs exists and transcript path
  const runsDir = path.join(workspace, '.runs');
  await ensureDir(runsDir);
  const fileTs = tsForFile();
  const transcriptPath = path.join(runsDir, `${engine}-${fileTs}.log`);
  const transcriptStream = fs.createWriteStream(transcriptPath, { flags: 'a' });
  const appendTranscript = async (text) => {
    try { await fsp.appendFile(transcriptPath, text); } catch (_) {}
  };

  const runId = uuidv4();
  const name = `adz-${engine}-${fileTs}-${runId.substring(0, 8)}`;

  const Env = [
    `ENGINE=${engine}`,
    'TERM=xterm-256color',
  ];
  if (extraEnv && typeof extraEnv === 'object') {
    for (const [k, v] of Object.entries(extraEnv)) {
      if (typeof v === 'string') Env.push(`${k}=${v}`);
    }
  }

  const HostConfig = {
    AutoRemove: true,
    Binds: [
      `${workspace}:/workspace:rw`,
      `${creds}:/home/agent/.creds:rw`,
    ],
    ...(readOnly ? { ReadonlyRootfs: true, Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=256m' } } : {}),
    // No resource caps yet; add in Phase 5.
  };

  const Labels = {
    'adz.engine': engine,
    'adz.workspace': workspace,
    'adz.creds': creds,
    'adz.runId': runId,
  };

  const createOpts = {
    name,
    Image: IMAGE,
    Tty: true,
    OpenStdin: true,
    StdinOnce: false,
    AttachStdout: true,
    AttachStderr: true,
    AttachStdin: true,
    Env,
    WorkingDir: '/workspace',
    HostConfig,
    Labels,
    // entrypoint remains the image default (/usr/bin/tini -- /entrypoint.sh)
    ...(Array.isArray(argv) && argv.length ? { Cmd: argv } : {}),
  };

  if (uidgid && /^(\d+):(\d+)$/.test(uidgid)) {
    createOpts.User = uidgid;
  }

  // Try warm pool: reuse a matching warm container via docker exec
  if (preferWarm) {
    const warm = await findWarmContainer({ engine, workspace, creds, readOnly, uidgid });
    if (warm) {
      // Exec into warm container and start entrypoint with ENGINE set
      const cmd = ['/entrypoint.sh', ...(Array.isArray(argv)? argv : [])];
      const exec = await warm.exec({
        AttachStdout: true,
        AttachStderr: true,
        AttachStdin: true,
        Tty: true,
        Env: [`ENGINE=${engine}`, 'TERM=xterm-256color'],
        WorkingDir: '/workspace',
        Cmd: cmd,
      });
      const stream = await exec.start({ hijack: true, stdin: true });

      const run = {
        id: runId,
        engine,
        workspace,
        creds,
        containerId: warm.id,
        containerName: warm.id.substring(0,12),
        startedAt: nowIso(),
        status: 'running',
        transcriptPath,
        appendTranscript,
        listeners: new Set(),
        attachStream: stream,
        container: warm,
        isExec: true,
        exec,
        lastActivityAt: Date.now(),
      };
      runs.set(runId, run);
      eventsBroadcast('run-started', { runId, engine, workspace, creds, warm: true, containerId: warm.id });

      stream.on('data', (chunk) => {
        run.lastActivityAt = Date.now();
        try { transcriptStream.write(chunk); } catch (_) {}
        const data = chunk.toString('utf8');
        for (const res of run.listeners) {
          try {
            const b64 = Buffer.from(chunk).toString('base64');
            res.write('event: chunk\n');
            res.write(`data: ${b64}\n\n`);
            res.write(`data: b64:${b64}\n\n`);
          } catch (_) { sseSend(res, data); }
        }
        for (const ln of data.split(/\r?\n/)) {
          if (!ln) continue;
          const evs = detectArtifactsFromLine(run, ln);
          for (const ev of evs) eventsBroadcast(ev.type, { runId, engine, workspace, ...ev });
        }
      });
      stream.on('error', (err) => {
        for (const res of run.listeners) sseSend(res, `[[ATTACH ERROR]] ${String(err)}`);
      });
      // No container wait here; rely on stream end events
      stream.on('end', async () => {
        run.status = 'exited';
        try { transcriptStream.end(); } catch (_) {}
        for (const res of run.listeners) { sseSend(res, `\n[[PROCESS EXITED]] status=${run.status}`); try { res.end(); } catch (_) {} }
        run.listeners.clear();
        eventsBroadcast('run-exited', { runId, engine, workspace, warm: true });
      });

      return { runId, containerName: run.containerName };
    }
  }

  const container = await docker.createContainer(createOpts);
  await container.start();

  const attachStream = await container.attach({ stream: true, stdout: true, stderr: true, stdin: true });

  const run = {
    id: runId,
    engine,
    workspace,
    creds,
    containerId: container.id,
    containerName: name,
    startedAt: nowIso(),
    status: 'running',
    transcriptPath,
    appendTranscript,
    listeners: new Set(),
    attachStream,
    container,
    _leftover: '',
    lastActivityAt: Date.now(),
  };

  runs.set(runId, run);
  eventsBroadcast('run-started', { runId, engine, workspace, creds, warm: false, containerId: container.id });

  // Stream container output to transcript and SSE listeners
  attachStream.on('data', (chunk) => {
    run.lastActivityAt = Date.now();
    try {
      transcriptStream.write(chunk);
    } catch (_) {}
    const data = chunk.toString('utf8');
    for (const res of run.listeners) {
      try {
        const b64 = Buffer.from(chunk).toString('base64');
        res.write('event: chunk\n');
        res.write(`data: ${b64}\n\n`);
        res.write(`data: b64:${b64}\n\n`);
      } catch (_) { sseSend(res, data); }
    }
    for (const ln of data.split(/\r?\n/)) {
      if (!ln) continue;
      const evs = detectArtifactsFromLine(run, ln);
      for (const ev of evs) eventsBroadcast(ev.type, { runId, engine, workspace, ...ev });
    }
  });

  attachStream.on('error', (err) => {
    for (const res of run.listeners) {
      sseSend(res, `[[ATTACH ERROR]] ${String(err)}`);
    }
  });

  container.wait().then(async () => {
    run.status = await resolveStatus(container);
    try { transcriptStream.end(); } catch (_) {}
    for (const res of run.listeners) {
      sseSend(res, `\n[[PROCESS EXITED]] status=${run.status}`);
      try { res.end(); } catch (_) {}
    }
    run.listeners.clear();
    eventsBroadcast('run-exited', { runId, engine, workspace, warm: false });
  }).catch(() => {});

  return { runId, containerName: name };
}

// -------- Phase 3: First-login readiness + creds helpers --------
function parseDotEnv(text) {
  const env = {};
  const lines = (text || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1);
    // Strip surrounding quotes if present
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

function serializeDotEnv(obj) {
  const keys = Object.keys(obj);
  return keys.map(k => `${k}=${obj[k]}`).join('\n') + (keys.length ? '\n' : '');
}

async function readCredsEnv(credsPath) {
  const envPath = path.join(credsPath, '.env');
  try {
    const txt = await fsp.readFile(envPath, 'utf8');
    return parseDotEnv(txt);
  } catch (_) {
    return {};
  }
}

async function writeCredsEnv(credsPath, updates) {
  const envPath = path.join(credsPath, '.env');
  const cur = await readCredsEnv(credsPath);
  const next = { ...cur, ...updates };
  // Remove keys explicitly set to empty string? Keep as given.
  const data = serializeDotEnv(next);
  await fsp.writeFile(envPath, data, 'utf8');
  return next;
}

async function dirNonEmpty(p) {
  try { const ent = await fsp.readdir(p); return ent.length > 0; } catch (_) { return false; }
}

async function checkReadiness(engine, credsPath) {
  if (!ENGINES.has(engine)) throw new Error('invalid engine');
  if (!isAllowed(credsPath, ALLOW_CREDS_ROOTS)) throw new Error('creds not under allowed roots');
  const env = await readCredsEnv(credsPath);
  const result = { engine, ready: false, reasons: [], found: { envKeys: [], dirs: {} } };
  const has = (k) => { if (env[k]) result.found.envKeys.push(k); return !!env[k]; };
  const existsDir = async (sub) => {
    const d = path.join(credsPath, sub); const ok = await dirNonEmpty(d); result.found.dirs[sub] = ok; return ok;
  };
  switch (engine) {
    case 'codex': {
      const hasKey = has('OPENAI_API_KEY');
      const hasDir = await existsDir('codex');
      result.ready = hasKey || hasDir;
      if (!result.ready) result.reasons.push('Codex needs ChatGPT sign-in or OPENAI_API_KEY');
      break;
    }
    case 'gemini': {
      const hasKey = has('GEMINI_API_KEY');
      const hasDir = await existsDir('gemini');
      const hasGcloud = await existsDir('gcloud');
      result.ready = hasKey || hasDir || hasGcloud;
      if (!result.ready) result.reasons.push('Gemini needs API key, device login, or Vertex ADC');
      result.found.vertexPossible = hasGcloud;
      break;
    }
    case 'opencode': {
      const ok = has('OPENAI_API_KEY') || has('ANTHROPIC_API_KEY') || has('GEMINI_API_KEY');
      const hasDir = await existsDir('opencode');
      result.ready = ok || hasDir;
      if (!result.ready) result.reasons.push('OpenCode needs a provider API key');
      break;
    }
  }
  return { readiness: result, env };
}

app.get('/creds/check', async (req, res) => {
  const { engine, creds } = req.query;
  if (!engine || !creds) return res.status(400).json({ error: 'engine and creds required' });
  const absCreds = path.resolve(String(creds));
  const out = await checkReadiness(String(engine), absCreds);
  res.json({ ...out.readiness });
});

app.post('/creds/write-env', async (req, res) => {
  const { creds, updates } = req.body || {};
  if (!creds || !updates || typeof updates !== 'object') return res.status(400).json({ error: 'creds and updates required' });
  const absCreds = path.resolve(String(creds));
  if (!isAllowed(absCreds, ALLOW_CREDS_ROOTS)) return res.status(400).json({ error: 'creds not under allowed roots' });
  await ensureDir(absCreds);
  const next = await writeCredsEnv(absCreds, updates);
  res.json({ ok: true, envKeys: Object.keys(next) });
});

// Routes
app.get('/health', (req, res) => {
  res.json({ ok: true, image: IMAGE, allow: { workspaces: ALLOW_WORKSPACE_ROOTS, creds: ALLOW_CREDS_ROOTS } });
});

// Whoami for convenience (UID:GID of spawner process)
app.get('/whoami', (req, res) => {
  let uid = null, gid = null;
  try { uid = process.getuid?.() ?? null; } catch (_) {}
  try { gid = process.getgid?.() ?? null; } catch (_) {}
  const uidgid = (uid != null && gid != null) ? `${uid}:${gid}` : null;
  res.json({ uid, gid, uidgid, platform: process.platform });
});

// Warm pool endpoints
app.get('/warm', async (req, res) => {
  const list = await docker.listContainers({ all: true, filters: { label: ['adz.warm=true'] } });
  res.json(list.map(c => ({ id: c.Id, name: (c.Names?.[0]||'').replace(/^\//,''), state: c.State, engine: (c.Labels||{})['adz.engine'], workspace: (c.Labels||{})['adz.workspace'], creds: (c.Labels||{})['adz.creds'] })));
});

app.post('/warm/ensure', async (req, res) => {
  const { engine, workspace, creds, readOnly = true, uidgid } = req.body || {};
  if (!ENGINES.has(engine)) return res.status(400).json({ error: 'invalid engine' });
  if (!path.isAbsolute(workspace) || !path.isAbsolute(creds)) return res.status(400).json({ error: 'workspace and creds must be absolute' });
  if (!isAllowed(workspace, ALLOW_WORKSPACE_ROOTS) || !isAllowed(creds, ALLOW_CREDS_ROOTS)) return res.status(400).json({ error: 'paths not allowed' });
  const out = await ensureWarmContainer({ engine, workspace, creds, readOnly, uidgid });
  res.json({ warmId: out.id, name: out.name });
});

app.delete('/warm/:id', async (req, res) => {
  try {
    const c = docker.getContainer(req.params.id);
    await c.stop({ t: 2 }).catch(() => {});
    await c.remove({ force: true }).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ error: 'not found' });
  }
});

// Stop/kill all runs (non-warm) and optional warm
app.post('/runs/stop-all', async (req, res) => {
  const includeWarm = req.query.includeWarm === '1' || req.query.includeWarm === 'true';
  const all = await listAdzContainers();
  let count = 0;
  for (const c of all) {
    const warm = c.Labels['adz.warm'] === 'true';
    if (warm && !includeWarm) continue;
    try { await docker.getContainer(c.Id).stop({ t: 2 }).catch(() => {}); } catch (_) {}
    try { await docker.getContainer(c.Id).remove({ force: true }).catch(() => {}); } catch (_) {}
    count++;
  }
  runs.clear();
  res.json({ ok: true, stopped: count, includeWarm: !!includeWarm });
});

app.post('/runs/kill-all', async (req, res) => {
  const includeWarm = req.query.includeWarm === '1' || req.query.includeWarm === 'true';
  const all = await listAdzContainers();
  let count = 0;
  for (const c of all) {
    const warm = c.Labels['adz.warm'] === 'true';
    if (warm && !includeWarm) continue;
    try { await docker.getContainer(c.Id).kill().catch(() => {}); } catch (_) {}
    try { await docker.getContainer(c.Id).remove({ force: true }).catch(() => {}); } catch (_) {}
    count++;
  }
  runs.clear();
  res.json({ ok: true, killed: count, includeWarm: !!includeWarm });
});

app.post('/runs', async (req, res) => {
  const { engine, workspace, creds, readOnly = true, uidgid, extraEnv, preferWarm = true, argv = [] } = req.body || {};
  const out = await startRun({ engine, workspace, creds, readOnly, uidgid, extraEnv, preferWarm, argv });
  res.json(out);
});

app.get('/runs', async (req, res) => {
  const list = [];
  for (const run of runs.values()) {
    let status = run.status;
    if (!run.isExec) {
      try { status = await resolveStatus(run.container); } catch (_) {}
    }
    list.push({ runId: run.id, engine: run.engine, workspace: run.workspace, status, startedAt: run.startedAt });
  }
  res.json(list);
});

app.get('/runs/:id/logs', async (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  const follow = req.query.follow === '1' || req.query.follow === 'true';
  createSSE(res);

  // Send existing transcript chunk (best-effort)
  try {
    if (fs.existsSync(run.transcriptPath)) {
      const stat = await fsp.stat(run.transcriptPath);
      const size = Math.min(stat.size, 64 * 1024); // tail last 64KB
      const fd = await fsp.open(run.transcriptPath, 'r');
      const { buffer } = await fd.read(Buffer.alloc(size), 0, size, stat.size - size);
      await fd.close();
      sseSend(res, buffer.toString('utf8'));
    }
  } catch (_) {}

  if (!follow) {
    return res.end();
  }

  run.listeners.add(res);
  req.on('close', () => {
    run.listeners.delete(res);
  });
});

app.post('/runs/:id/input', async (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  const { data } = req.body || {};
  if (typeof data !== 'string') return res.status(400).json({ error: 'data must be string' });
  try {
    run.attachStream.write(data);
  } catch (e) {
    return res.status(500).json({ error: 'write failed', detail: String(e) });
  }
  run.lastActivityAt = Date.now();
  res.json({ ok: true });
});

app.delete('/runs/:id', async (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) {
    try {
      const list = await docker.listContainers({ all: true, filters: { label: [`adz.runId=${req.params.id}`] } });
      for (const c of list) {
        try { await docker.getContainer(c.Id).stop({ t: 2 }).catch(() => {}); } catch (_) {}
        try { await docker.getContainer(c.Id).remove({ force: true }).catch(() => {}); } catch (_) {}
      }
      return res.json({ ok: true, removed: list.length > 0, fallback: true });
    } catch (_) { return res.status(404).json({ error: 'not found' }); }
  }
  if (run.isExec) {
    try { run.attachStream.write('\u0003'); } catch (_) {} // Ctrl-C
    try { run.attachStream.write('exit\n'); } catch (_) {}
    run.status = 'stopped';
    eventsBroadcast('run-stopped', { runId: run.id, engine: run.engine, workspace: run.workspace, warm: true });
    try { run.listeners.forEach((r)=>{ try { r.end(); } catch(_){} }); run.listeners.clear(); } catch(_){}
    runs.delete(run.id);
    return res.json({ ok: true, removed: true });
  } else {
    try { await run.container.stop({ t: 2 }).catch(() => {}); } catch (_) {}
    try { await run.container.remove({ force: true }).catch(() => {}); } catch (_) {}
    run.status = 'stopped';
    eventsBroadcast('run-stopped', { runId: run.id, engine: run.engine, workspace: run.workspace, warm: false });
    try { run.listeners.forEach((r)=>{ try { r.end(); } catch(_){} }); run.listeners.clear(); } catch(_){}
    runs.delete(run.id);
    return res.json({ ok: true, removed: true });
  }
});

// Immediate kill
app.post('/runs/:id/kill', async (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) {
    try {
      const list = await docker.listContainers({ all: true, filters: { label: [`adz.runId=${req.params.id}`] } });
      for (const c of list) {
        try { await docker.getContainer(c.Id).kill().catch(() => {}); } catch (_) {}
        try { await docker.getContainer(c.Id).remove({ force: true }).catch(() => {}); } catch (_) {}
      }
      return res.json({ ok: true, removed: list.length > 0, fallback: true });
    } catch (_) { return res.status(404).json({ error: 'not found' }); }
  }
  if (run.isExec) {
    // Kill only the CLI process inside container, keep warm container
    try {
      const killer = await run.container.exec({
        AttachStdout: true, AttachStderr: true, Tty: false,
        Cmd: ['bash', '-lc', `pkill -9 -f '^(codex|gemini|opencode)$' || true`]
      });
      await killer.start({});
    } catch (_) {}
    run.status = 'killed';
    eventsBroadcast('run-killed', { runId: run.id, engine: run.engine, workspace: run.workspace, warm: true });
    try { run.listeners.forEach((r)=>{ try { r.end(); } catch(_){} }); run.listeners.clear(); } catch(_){}
    runs.delete(run.id);
    return res.json({ ok: true, removed: true });
  } else {
    try { await run.container.kill().catch(() => {}); } catch (_) {}
    try { await run.container.remove({ force: true }).catch(() => {}); } catch (_) {}
    run.status = 'killed';
    eventsBroadcast('run-killed', { runId: run.id, engine: run.engine, workspace: run.workspace, warm: false });
    try { run.listeners.forEach((r)=>{ try { r.end(); } catch(_){} }); run.listeners.clear(); } catch(_){}
    runs.delete(run.id);
    return res.json({ ok: true, removed: true });
  }
});

// Unified close endpoint: terminate process/container and remove from registry
app.post('/runs/:id/close', async (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) {
    try {
      const list = await docker.listContainers({ all: true, filters: { label: [`adz.runId=${req.params.id}`] } });
      for (const c of list) {
        try { await docker.getContainer(c.Id).kill().catch(() => {}); } catch (_) {}
        try { await docker.getContainer(c.Id).remove({ force: true }).catch(() => {}); } catch (_) {}
      }
      return res.json({ ok: true, removed: list.length > 0, fallback: true });
    } catch (_) { return res.status(404).json({ error: 'not found' }); }
  }
  try {
    if (run.isExec) {
      try { run.attachStream.end?.(); run.attachStream.destroy?.(); } catch(_){}
      try {
        const killer = await run.container.exec({ AttachStdout: false, AttachStderr: false, Tty: false, Cmd: ['bash','-lc', 'pkill -KILL -f "(/entrypoint.sh|codex|gemini|opencode)" || true'] });
        await killer.start({});
      } catch(_){}
    } else {
      try { await run.container.kill().catch(()=>{}); } catch(_){}
      try { await run.container.remove({ force: true }).catch(()=>{}); } catch(_){}
    }
  } catch(_){}
  try { run.listeners.forEach((r)=>{ try { r.end(); } catch(_){} }); run.listeners.clear(); } catch(_){}
  runs.delete(run.id);
  eventsBroadcast('run-closed', { runId: run.id, engine: run.engine, workspace: run.workspace, warm: !!run.isExec });
  res.json({ ok: true, removed: true });
});

app.get('/runs/:id/meta', async (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  let inspect;
  try { inspect = await run.container.inspect(); } catch (_) {}
  const mounts = inspect?.Mounts?.map((m) => ({ source: m.Source, target: m.Destination, rw: m.RW })) || [];
  res.json({
    runId: run.id,
    containerId: run.containerId,
    containerName: run.containerName,
    engine: run.engine,
    image: IMAGE,
    transcriptPath: run.transcriptPath,
    labels: inspect?.Config?.Labels || {},
    mounts,
    preferWarm: !!run.isExec,
  });
});

// Artifacts: transcripts and recent files
async function listTranscripts(workspace) {
  const dir = path.join(workspace, '.runs');
  try {
    const items = await fsp.readdir(dir);
    const stats = await Promise.all(items.map(async (name) => {
      const p = path.join(dir, name);
      const st = await fsp.stat(p).catch(() => null);
      if (!st || !st.isFile()) return null;
      return { path: p, size: st.size, mtime: st.mtimeMs };
    }));
    return stats.filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, 50);
  } catch (_) { return []; }
}

async function listRecentFiles(workspace, limit = 50) {
  const exclude = new Set(['node_modules', '.git', '.runs', '.venv', 'venv', 'dist', 'build']);
  const out = [];
  async function walk(dir, depth) {
    if (out.length >= 500) return; // hard cap to avoid heavy scans
    let ents = [];
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (e.name.startsWith('.DS_')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (exclude.has(e.name)) continue;
        if (depth < 3) await walk(p, depth + 1);
      } else if (e.isFile()) {
        try {
          const st = await fsp.stat(p);
          out.push({ path: p, size: st.size, mtime: st.mtimeMs });
        } catch (_) {}
      }
    }
  }
  await walk(workspace, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

app.get('/runs/:id/artifacts', async (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  const transcripts = await listTranscripts(run.workspace);
  const recentFiles = await listRecentFiles(run.workspace, 30);
  res.json({ transcripts, recentFiles });
});

// Download a file under the workspace
app.get('/runs/:id/file', async (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  const p = String(req.query.path || '');
  if (!p) return res.status(400).json({ error: 'path required' });
  const abs = path.resolve(p);
  if (!isSubPath(abs, run.workspace) && abs !== path.join(run.workspace, '.runs')) {
    return res.status(400).json({ error: 'path outside workspace' });
  }
  try {
    const stat = await fsp.stat(abs);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(abs)}"`);
    fs.createReadStream(abs).pipe(res);
  } catch (e) {
    res.status(404).json({ error: 'not found' });
  }
});
const publicDir = path.join(__dirname, '..', 'public');
// Serve index with no-store headers to avoid stale HTML/CSS in browsers
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(publicDir, 'index.html'));
});
app.get('/index.html', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(publicDir, 'index.html'));
});
// Favicon placeholder to avoid 404 noise
app.get('/favicon.ico', (req, res) => { res.status(204).end(); });
// Static assets (ok to cache)
app.use('/', express.static(publicDir));
// Serve xterm assets locally to avoid CDN dependency
const xtermDir = path.join(__dirname, '..', 'node_modules', 'xterm');
app.use('/xterm', express.static(xtermDir));

// Basic error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(400).json({ error: String(err?.message || err) });
});

// Events SSE endpoint for board integration
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  eventClients.add(res);
  req.on('close', () => { eventClients.delete(res); });
});

const server = app.listen(PORT, BIND_HOST, () => {
  console.log(`[spawner] listening on http://${BIND_HOST}:${PORT}`);
  console.log(`[spawner] image=${IMAGE}`);
  console.log(`[spawner] allow workspaces: ${ALLOW_WORKSPACE_ROOTS.join(', ')}`);
  console.log(`[spawner] allow creds: ${ALLOW_CREDS_ROOTS.join(', ')}`);
  if (IDLE_TIMEOUT_SEC > 0) console.log(`[spawner] idle timeout: ${IDLE_TIMEOUT_SEC}s`);
});

// Auto-idle stopper
async function autoStopRun(run) {
  const msg = `\n[[AUTO-STOP]] idle timeout exceeded (${IDLE_TIMEOUT_SEC}s). Stopping run.\n`;
  try { await fsp.appendFile(run.transcriptPath, msg); } catch (_) {}
  for (const res of run.listeners) { sseSend(res, msg); try { res.end(); } catch (_) {} }
  run.listeners.clear();
  try {
    if (run.isExec) {
      try { run.attachStream.write('\u0003'); } catch (_) {}
      try { run.attachStream.write('exit\n'); } catch (_) {}
      run.status = 'stopped';
      eventsBroadcast('run-idle-stopped', { runId: run.id, engine: run.engine, workspace: run.workspace, warm: true });
    } else {
      await run.container.stop({ t: 2 }).catch(() => {});
      await run.container.remove({ force: true }).catch(() => {});
      run.status = 'stopped';
      eventsBroadcast('run-idle-stopped', { runId: run.id, engine: run.engine, workspace: run.workspace, warm: false });
    }
  } catch (_) {}
}

if (IDLE_TIMEOUT_SEC > 0) {
  setInterval(() => {
    const now = Date.now();
    for (const run of runs.values()) {
      if (run.status !== 'running') continue;
      if (!run.lastActivityAt) continue;
      const idle = (now - run.lastActivityAt) / 1000;
      if (idle >= IDLE_TIMEOUT_SEC) {
        autoStopRun(run).catch(() => {});
      }
    }
  }, 30000);
}

// WebSocket attach (low-latency, bidirectional)
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (!url.pathname.startsWith('/ws/runs/')) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, url);
    });
  } catch (_) {
    socket.destroy();
  }
});

wss.on('connection', (ws, req, url) => {
  const id = url.pathname.split('/').pop();
  const run = runs.get(id);
  if (!run) {
    try { ws.close(1011, 'run not found'); } catch (_) {}
    return;
  }
  // Forward docker attach output to WS as binary
  const onData = (chunk) => {
    try { ws.readyState === 1 && ws.send(chunk); } catch (_) {}
  };
  run.attachStream.on('data', onData);

  ws.on('message', async (msg, isBinary) => {
    try {
      if (!isBinary) {
        // Handle control frames as JSON: { type: 'resize', cols, rows }
        const s = msg.toString();
        try {
          const obj = JSON.parse(s);
          if (obj && obj.type === 'resize' && Number(obj.cols) && Number(obj.rows)) {
            if (run.isExec && run.exec) {
              try { await run.exec.resize({ h: Number(obj.rows), w: Number(obj.cols) }); } catch (_) {}
            } else {
              try { await run.container.resize({ h: Number(obj.rows), w: Number(obj.cols) }); } catch (_) {}
            }
            return;
          }
        } catch (_) { /* fallthrough to input */ }
      }
      run.attachStream.write(isBinary ? msg : Buffer.from(msg));
    } catch (_) {}
  });

  ws.on('close', () => {
    run.attachStream.off?.('data', onData);
  });
});
