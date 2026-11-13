#!/usr/bin/env node
// Shape check for a DSH bundle repo: manifest targets, patch insert, locale keys,
// README sections, and files coverage. Copy next to the plugin's scripts/ and
// adjust REQUIRED_SECTIONS / LOCALE_DIR when the plugin deviates on purpose.
// Shared rules belong in dsh-plugin-devkit's doctor. Keep here what is specific
// to this repo and what doctor cannot do, such as running Config.validate.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const errors = [];
const warnings = [];
const read = p => readFileSync(resolve(root, p), 'utf8');
const fail = m => errors.push(m);
const warn = m => warnings.push(m);

const pkg = JSON.parse(read('package.json'));

// --- manifest ---------------------------------------------------------------
if (!/^dsh-[a-z0-9-]+$/.test(pkg.name)) fail(`package.json name "${pkg.name}" should be dsh-<purpose>`);
if (pkg.type !== 'module') fail('package.json type must be "module"');
if (!pkg.version) fail('package.json version is missing');
if (!pkg.files?.length) fail('package.json files is empty; the tarball would be nearly empty');
if (!pkg.dsh?.bundle?.patch) fail('package.json dsh.bundle.patch is missing; DSH will not load this bundle');
if (!(pkg.keywords ?? []).includes('dsh-plugin')) warn('keywords should include "dsh-plugin"');
if (!existsSync(resolve(root, 'LICENSE'))) warn('LICENSE is missing');

// Every export target and the entry file must exist, or the bundle cannot load.
const targets = new Set();
if (pkg.main) targets.add(pkg.main);
const exportsField = pkg.exports;
if (typeof exportsField === 'string') targets.add(exportsField);
else if (exportsField && typeof exportsField === 'object') {
	for (const value of Object.values(exportsField)) {
		if (typeof value === 'string') targets.add(value);
		else if (value && typeof value === 'object') for (const v of Object.values(value)) if (typeof v === 'string') targets.add(v);
	}
}
for (const target of targets) if (!existsSync(resolve(root, target))) fail(`exports target does not exist: ${target}`);

// files must cover every runtime file the manifest points at. npm always ships
// package.json, so it needs no entry of its own.
const norm = path => path.replace(/^\.\//, '').replace(/\/$/, '');
const listed = (pkg.files ?? []).map(norm);
for (const raw of targets) {
	const target = norm(raw);
	if (target === 'package.json') continue;
	const ok = listed.some(f => target === f || target.startsWith(`${f}/`) || (f.includes('*') && target.startsWith(f.split('*')[0])));
	if (!ok) fail(`files does not cover runtime file: ${raw}`);
}

// --- patch ------------------------------------------------------------------
const patchPath = pkg.dsh?.bundle?.patch;
if (patchPath && existsSync(resolve(root, patchPath))) {
	const patch = read(patchPath);
	if (!/^\s*-\s*insert:/m.test(patch)) fail(`${patchPath} has no insert row; the bundle would install as a no-op`);
	const ids = [...patch.matchAll(/\bid:\s*([^\s]+)/g)].map(m => m[1]);
	if (new Set(ids).size !== ids.length) fail(`${patchPath} repeats an insert id`);
}

// --- Config -----------------------------------------------------------------
// cordis calls Config['~standard'].validate(config) at load. A plain object has
// no such key, so the bundle dies at load while unit tests and CI stay green.
// Replay it on the two values a patch can send; bundles that declare no Config
// are the common case and pass straight through.
const entry = typeof exportsField === 'string' ? exportsField : exportsField?.['.']?.default ?? exportsField?.['.'] ?? pkg.main;
if (typeof entry === 'string' && existsSync(resolve(root, entry))) {
	let mod;
	try {
		mod = await import(pathToFileURL(resolve(root, entry)).href);
	} catch (error) {
		// Peers such as zod come from the host, so an import failure here proves nothing.
		warn(`could not import ${entry} to check Config: ${error.message}`);
	}
	if (mod?.Config) {
		const validate = mod.Config['~standard']?.validate;
		if (typeof validate !== 'function') fail('Config is not a standard-schema; cordis needs Config["~standard"].validate and the bundle would fail to load');
		else {
			for (const value of [undefined, {}]) {
				let result;
				try {
					result = validate(value);
				} catch (error) {
					fail(`Config validate(${JSON.stringify(value)}) threw: ${error.message}`);
					continue;
				}
				if (typeof result?.then === 'function') fail('Config validate must be synchronous; cordis rejects a Promise');
				else if (result?.issues) fail(`Config rejects ${JSON.stringify(value)}: ${result.issues[0]?.message}`);
			}
		}
	}
}

// --- README -----------------------------------------------------------------
const REQUIRED_SECTIONS = ['功能', '安裝', '使用', '疑難排解', '運作原理', '開發', '已知限制'];
const readme = existsSync(resolve(root, 'README.md')) ? read('README.md') : '';
if (!readme) fail('README.md is missing');
else {
	for (const section of REQUIRED_SECTIONS) if (!readme.includes(`## ${section}`)) fail(`README.md is missing section: ## ${section}`);
	if (!/https:\/\/github\.com\/[^/\s]+\/[^/\s#?]+(?:[#?][^\s)]*)?\s*$/m.test(readme)) warn('README install section should contain a repository home URL');
}

// --- locale -----------------------------------------------------------------
const localeDir = resolve(root, 'locale');
if (existsSync(localeDir)) {
	const files = readdirSync(localeDir).filter(f => f.endsWith('.json'));
	if (files.length < 2) warn('locale should have at least zh.json and en.json');
	const shapes = files.map(file => {
		try {
			return { file, json: JSON.parse(read(join('locale', file))) };
		} catch (error) {
			fail(`locale/${file} is not valid JSON: ${error.message}`);
			return null;
		}
	}).filter(Boolean);
	const keys = shapes.map(s => Object.keys(s.json.meta ?? {}).sort().join(','));
	if (new Set(keys).size > 1) fail('locale files disagree on meta keys');
	for (const s of shapes) {
		if (!s.json.meta?.title) fail(`locale/${s.file} meta.title is empty`);
	}
}

// --- artifacts --------------------------------------------------------------
for (const entry of readdirSync(root)) if (entry.endsWith('.tgz')) warn(`*.tgz in the repo root: ${entry} belongs in a GitHub release, not in git`);

// --- report -----------------------------------------------------------------
for (const w of warnings) console.warn(`warn  ${w}`);
for (const e of errors) console.error(`error ${e}`);
if (errors.length) process.exit(1);
console.log(`ok    ${pkg.name}@${pkg.version} — ${warnings.length} warning(s)`);
