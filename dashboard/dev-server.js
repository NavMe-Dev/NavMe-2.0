import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3001;

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  // Handle CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Proxy /api/multiset to actual API
  if (req.url.startsWith('/api/multiset')) {
    const targetUrl = req.url.replace(/^\/api\/multiset/, '');
    fetch(`https://api.multiset.ai${targetUrl}`, {
      headers: { 'User-Agent': 'nav-me-dev/1.0' },
    })
      .then(r => r.text().then(body => ({ r, body })))
      .then(({ r, body }) => {
        res.writeHead(r.status, {
          'Content-Type': r.headers.get('content-type'),
          'Access-Control-Allow-Origin': '*',
        });
        res.end(body);
      })
      .catch(err => {
        res.writeHead(502);
        res.end('Proxy error: ' + err.message);
      });
    return;
  }

  // S3 proxy
  if (req.url.startsWith('/s3-proxy')) {
    const targetUrl = req.url.replace(/^\/s3-proxy/, '');
    fetch(`https://prod-multiset.s3-accelerate.amazonaws.com${targetUrl}`)
      .then(r => r.buffer().then(body => ({ r, body })))
      .then(({ r, body }) => {
        res.writeHead(r.status, {
          'Content-Type': r.headers.get('content-type'),
          'Access-Control-Allow-Origin': '*',
        });
        res.end(body);
      })
      .catch(err => {
        res.writeHead(502);
        res.end('Proxy error: ' + err.message);
      });
    return;
  }

  // Serve static files
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Try index.html for SPA routing
      if (err.code === 'ENOENT' && ext === '') {
        fs.readFile(path.join(__dirname, 'index.html'), (err2, data2) => {
          if (err2) {
            res.writeHead(404);
            res.end('Not found');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data2);
          }
        });
        return;
      }
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Development server running at http://localhost:${PORT}`);
  console.log(`📁 Serving files from: ${__dirname}`);
  console.log(`⚠️  Note: This is a basic dev server. JS/CSS are not transformed - use for testing only.`);
});
