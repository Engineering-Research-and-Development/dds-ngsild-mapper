#!/usr/bin/env node
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT           = process.env.MOCK_PORT || 8080;
const DISCOVERY_FILE = path.join(__dirname, 'discovery.json');

// How the WebSocket endpoint emits the inventory:
//   snapshot → one frame with the full { topics, services, actions } object
//   events   → one frame per entry: { kind, name, ... } (streamed with a small delay)
const WS_MODE     = process.env.MOCK_WS_MODE || 'events';
const WS_DELAY_MS = Number(process.env.MOCK_WS_DELAY_MS) || 50;

const discovery = JSON.parse(fs.readFileSync(DISCOVERY_FILE, 'utf8'));
const body      = JSON.stringify(discovery, null, 2);

// ─── HTTP endpoint ──────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && url === '/api/discovery') {
    console.log(`[mock] GET /api/discovery  →  ${discovery.topics.length} topics, ${discovery.services.length} services, ${discovery.actions.length} actions`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
    return;
  }

  if (req.method === 'GET' && url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok\n');
    return;
  }

  console.log(`[mock] 404  ${req.method} ${req.url}`);
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found\n');
});

// ─── WebSocket endpoint (same port, path /api/discovery) ─────────────────────────

const wss = new WebSocketServer({ server, path: '/api/discovery' });

wss.on('connection', socket => {
  console.log(`[mock] WS connection  (mode=${WS_MODE})`);

  socket.on('message', msg => console.log(`[mock] WS recv: ${msg.toString('utf8')}`));

  if (WS_MODE === 'snapshot') {
    socket.send(body);
    console.log('[mock] WS sent full snapshot');
    socket.close();
    return;
  }

  // events mode: stream one frame per entry, then close.
  const frames = [
    ...discovery.topics.map(t   => ({ kind: 'topic',   ...t })),
    ...discovery.services.map(s => ({ kind: 'service', ...s })),
    ...discovery.actions.map(a  => ({ kind: 'action',  ...a })),
  ];

  let i = 0;
  const timer = setInterval(() => {
    if (socket.readyState !== socket.OPEN || i >= frames.length) {
      clearInterval(timer);
      if (socket.readyState === socket.OPEN) {
        console.log(`[mock] WS streamed ${frames.length} frames`);
        socket.close();
      }
      return;
    }
    socket.send(JSON.stringify(frames[i++]));
  }, WS_DELAY_MS);

  socket.on('close', () => clearInterval(timer));
});

server.listen(PORT, () => {
  console.log(`[mock] DDS discovery server listening on http://localhost:${PORT}`);
  console.log(`[mock] HTTP endpoint: http://localhost:${PORT}/api/discovery`);
  console.log(`[mock] WS   endpoint: ws://localhost:${PORT}/api/discovery   (mode=${WS_MODE})`);
  console.log('[mock] Press Ctrl+C to stop.\n');
});
