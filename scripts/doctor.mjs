import { CodexClient } from '../src/codex.mjs';
const client = new CodexClient();
try { console.log(JSON.stringify(await client.doctor(), null, 2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
finally { client.close(); }
