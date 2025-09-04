// Minimal client for board integration

export function startRun(baseUrl, body) {
  return fetch(new URL('/runs', baseUrl), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  }).then(r => { if (!r.ok) throw new Error('start failed'); return r.json(); });
}

export function stopRun(baseUrl, runId) {
  return fetch(new URL(`/runs/${runId}`, baseUrl), { method: 'DELETE' }).then(r => r.json());
}

export function sendInput(baseUrl, runId, data) {
  return fetch(new URL(`/runs/${runId}/input`, baseUrl), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data })
  }).then(r => r.json());
}

export function logsStream(baseUrl, runId, onLine) {
  const src = new EventSource(new URL(`/runs/${runId}/logs?follow=1`, baseUrl));
  src.onmessage = (ev) => onLine && onLine(ev.data);
  return () => src.close();
}

export function eventsStream(baseUrl, onEvent) {
  const src = new EventSource(new URL('/events', baseUrl));
  src.onmessage = (ev) => onEvent && onEvent(JSON.parse(ev.data));
  src.addEventListener('artifact', (ev) => onEvent && onEvent(JSON.parse(ev.data)));
  return () => src.close();
}

