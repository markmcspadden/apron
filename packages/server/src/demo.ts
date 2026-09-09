import { createServer } from './server.js';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);
const scenarioName = process.env['SCENARIO'] ?? 'alcs-gm4';

const server = await createServer({ autoPlay: true, demoMode: true });
server.listen(PORT, () => {
  console.log(`\n  APRON — demo mode (standalone)`);
  console.log(`  Scenario: ${scenarioName}\n`);
  console.log(`  Board:     http://localhost:${PORT}/demo`);
  console.log(`  Marketing: http://localhost:${PORT}/`);
  console.log(`  API:       http://localhost:${PORT}/api/status\n`);
  console.log(`  The scenario will auto-play when a client connects.\n`);
});
