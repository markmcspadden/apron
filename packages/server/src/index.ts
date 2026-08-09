import { createServer } from './server.js';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

const server = await createServer();
server.listen(PORT, () => {
  console.log(`\n  APRON — crew integrity board`);
  console.log(`  http://localhost:${PORT}\n`);
  console.log(`  Board:     http://localhost:${PORT}/board`);
  console.log(`  Admin:     http://localhost:${PORT}/admin`);
  console.log(`  Demo:      http://localhost:${PORT}/demo`);
  console.log(`  Marketing: http://localhost:${PORT}/`);
  console.log(`  API:       http://localhost:${PORT}/api/status\n`);
});
