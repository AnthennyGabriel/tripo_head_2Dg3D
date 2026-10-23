import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'js-yaml';

// Read staged blobs, not working-tree files: exactly what the next commit contains.
const git = args => execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const known = [];
function collect(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && /(?:key|token|secret|password)/i.test(key) && item.length >= 8) {
      known.push(Buffer.from(item), Buffer.from(encodeURIComponent(item)), Buffer.from(Buffer.from(item).toString('base64')));
    } else if (typeof item === 'object') collect(item);
  }
}
const args = process.argv.slice(2);
try {
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--secrets-from' || !args[i + 1]) throw new Error('arguments');
    collect(YAML.load(readFileSync(args[++i], 'utf8')));
  }
} catch {
  console.error('Cannot load private comparison configuration or invalid arguments; no values printed.');
  process.exit(2);
}

let names;
try { names = git(['ls-files', '-z']).toString('utf8').split('\0').filter(Boolean); }
catch { console.error('Run this check inside a Git checkout.'); process.exit(2); }
if (!names.length) { console.error('No staged/tracked files to inspect. Run git add first.'); process.exit(2); }
const findings = [];
for (const name of names) {
  const base = path.posix.basename(name);
  const denied = (/^\.env(?:\.|$)/.test(base) && base !== '.env.example') ||
    (/^config(?:\..*)?\.ya?ml$/i.test(base) && base !== 'config.example.yaml') ||
    /\.(pem|key|p12|pfx|zip|tar|gz)$/i.test(base) || /(?:^|\/)(?:node_modules|jobs|data|output)(?:\/|$)/.test(name);
  if (denied) findings.push([name, 'forbidden delivery path']);
  const bytes = git(['show', `:${name}`]);
  if (known.some(secret => bytes.includes(secret))) findings.push([name, 'known credential']);
  const text = bytes.toString('utf8');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) findings.push([name, 'private key']);
  if (/(?:gh[pousr]_|github_pat_|sk-(?:proj-)?)[A-Za-z0-9_-]{20,}/.test(text)) findings.push([name, 'credential token format']);
  if (/^\s*["']?(?:api_key|apiKey|access_token|secret_key)["']?\s*:\s*["']?[A-Za-z0-9_\-+/=]{12,}/m.test(text)) findings.push([name, 'nonempty credential literal']);
  if (/https?:\/\/[^\s/:@]+:[^\s/@]+@/.test(text)) findings.push([name, 'URL with credentials']);
}
for (const [name, rule] of findings) console.error(`${name}: ${rule}`);
if (findings.length) process.exit(1);
console.log(`PASS: ${names.length} Git-index files; no blocked paths or detected credentials${known.length ? '; private-value comparison enabled' : ''}.`);
