const http = require('node:http');
const path = require('node:path');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 8787;
const DB_FILE = process.env.METRICS_DB || path.join(__dirname, 'data', 'metrics.sqlite');

function startServer() {
  const { handler } = createApp({ dbFile: DB_FILE });
  const server = http.createServer(handler);
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`vb-metrics dashboard on http://localhost:${PORT}  (db: ${DB_FILE})`);
  });
  return server;
}

if (require.main === module) startServer();

module.exports = { startServer };
