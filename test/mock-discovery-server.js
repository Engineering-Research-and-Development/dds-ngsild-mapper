#!/usr/bin/env node
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT          = process.env.MOCK_PORT || 8080;
const DISCOVERY_FILE = path.join(__dirname, 'discovery.json');

const discovery = JSON.parse(fs.readFileSync(DISCOVERY_FILE, 'utf8'));
const body      = JSON.stringify(discovery, null, 2);

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

server.listen(PORT, () => {
  console.log(`[mock] DDS discovery server listening on http://localhost:${PORT}`);
  console.log(`[mock] Endpoint: http://localhost:${PORT}/api/discovery`);
  console.log('[mock] Press Ctrl+C to stop.\n');
});
