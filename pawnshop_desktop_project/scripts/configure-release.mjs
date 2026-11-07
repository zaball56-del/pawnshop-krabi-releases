import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packagePath = resolve(root, 'package.json');
const configPath = resolve(root, 'electron', 'update-config.json');
const repository = process.env.GITHUB_REPOSITORY || '';
const [envOwner, envRepo] = repository.split('/');
const owner = envOwner || process.env.PAWNSHOP_GITHUB_OWNER;
const repo = envRepo || process.env.PAWNSHOP_GITHUB_REPO;

if (!owner || !repo) {
  process.stdout.write('GitHub owner/repository not provided. Automatic updates remain disabled until configured.\n');
  process.exit(0);
}

const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
packageJson.build.publish = [{ provider: 'github', owner, repo, releaseType: 'release' }];
await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
await writeFile(configPath, `${JSON.stringify({ provider: 'github', owner, repo }, null, 2)}\n`);
process.stdout.write(`Configured release target: https://github.com/${owner}/${repo}\n`);
