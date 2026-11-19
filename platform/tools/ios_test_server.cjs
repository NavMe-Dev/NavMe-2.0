// Pretest Server for NavMe on iOS (Node.js built-in, zero dependencies)
// Serves local modified viewer files from platform/viewer and proxies APIs to production
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PORT = process.env.PORT || 8780;
const PROD_BASE = 'https://wayfinding.navme.space';
const VIEWER_DIR = path.resolve(__dirname, '../viewer');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function getLocalIps() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

function proxyToProd(req, res, targetUrl) {
  const url = new URL(targetUrl);
  const options = {
    hostname: url.hostname,
    port: 443,
    path: url.pathname + url.search,
    method: req.method,
    headers: {
      ...req.headers,
      host: url.hostname,
      origin: PROD_BASE,
      referer: PROD_BASE + '/',
    },
  };

  const proxyReq = https.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Proxy error: ' + err.message);
  });

  req.pipe(proxyReq, { end: true });
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  let pathname = parsed.pathname;

  // Route alias: /unc-charlotte -> index.html
  if (pathname === '/unc-charlotte' || pathname === '/unc-charlotte/') {
    pathname = '/index.html';
  }

  // APIs & dynamic requests -> proxy to live production
  if (pathname.startsWith('/api/') || pathname.startsWith('/locales/')) {
    return proxyToProd(req, res, PROD_BASE + req.url);
  }

  // Check local viewer directory
  let filePath = path.join(VIEWER_DIR, pathname === '/' ? 'index.html' : pathname);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    return fs.createReadStream(filePath).pipe(res);
  }

  // Fallback: proxy missing static assets (e.g. vendor files or remote builds) to prod
  proxyToProd(req, res, PROD_BASE + req.url);
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIps();
  console.log(`\n======================================================`);
  console.log(`🚀 NavMe iOS Pretest Server running on port ${PORT}`);
  console.log(`======================================================`);
  console.log(`\nLocal PC:`);
  console.log(`  http://localhost:${PORT}/unc-charlotte`);
  console.log(`\nOn your iPhone (connected to same Wi-Fi or Hotspot):`);
  ips.forEach((ip) => {
    console.log(`  👉 http://${ip}:${PORT}/unc-charlotte`);
  });
  console.log(`\nFor HTTPS via Cloudflare Tunnel (instant free link):`);
  console.log(`  npx cloudflared tunnel --url http://localhost:${PORT}`);
  console.log(`======================================================\n`);
});
