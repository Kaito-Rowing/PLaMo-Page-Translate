import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const manifest = JSON.parse(readFileSync('extension/manifest.json', 'utf8'));
if (version !== manifest.version) throw new Error('Package and manifest versions must match');
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) {
  throw new Error('Release tag must match the package version');
}
for (const file of readdirSync('extension')) {
  if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', `extension/${file}`], { stdio: 'inherit' });
}
for (const file of readdirSync('scripts')) {
  if (file.endsWith('.mjs')) execFileSync(process.execPath, ['--check', `scripts/${file}`], { stdio: 'inherit' });
}
