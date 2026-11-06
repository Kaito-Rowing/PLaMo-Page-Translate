import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
for (const file of readdirSync('extension')) {
  if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', `extension/${file}`], { stdio: 'inherit' });
}
for (const file of readdirSync('scripts')) {
  if (file.endsWith('.mjs')) execFileSync(process.execPath, ['--check', `scripts/${file}`], { stdio: 'inherit' });
}
