import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const checker = fileURLToPath(new URL('../scripts/check-npq-audit.mjs', import.meta.url));
const deprecated = {
	severity: 'error',
	marshall: 'deprecation',
	category: { id: 'PackageHealth', title: 'Package Health' },
	message:
		'Package deprecated: This version is no longer supported. Please see https://eslint.org/version-support for other options.',
};

function audit() {
	return {
		schemaVersion: 1,
		tool: { name: 'npq', version: '3.27.0' },
		status: 'findings',
		summary: { packagesAudited: 2, errors: 1, warnings: 0 },
		packages: [
			{ requested: 'eslint@9.39.5', findings: [{ ...deprecated }] },
			{ requested: 'typescript@5.9.2', findings: [] },
		],
		failures: [],
	};
}

function check(report, exitCode = 1, eslintVersion = '9.39.5', dependencies) {
	const directory = mkdtempSync(join(tmpdir(), 'n8n-npq-'));
	try {
		writeFileSync(
			join(directory, 'package.json'),
			JSON.stringify({
				dependencies,
				devDependencies: { eslint: eslintVersion, typescript: '5.9.2' },
			}),
		);
		writeFileSync(join(directory, 'audit.json'), JSON.stringify(report));
		return spawnSync(process.execPath, [checker, 'audit.json', String(exitCode)], {
			cwd: directory,
			encoding: 'utf8',
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

test('allows the exact ESLint deprecation and reports the exception', () => {
	const result = check(audit());
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Exception applied: eslint@9\.39\.5 deprecation/);
});

test('allows a warning-only audit', () => {
	const report = audit();
	report.packages[0].findings[0].severity = 'warning';
	report.summary = { packagesAudited: 2, errors: 0, warnings: 1 };
	assert.equal(check(report).status, 0);
});

test('allows a clean audit', () => {
	const report = audit();
	report.packages[0].findings = [];
	report.status = 'clean';
	report.summary.errors = 0;
	assert.equal(check(report, 0).status, 0);
});

test('covers dependencies declared in both dependency sections', () => {
	const report = audit();
	report.packages.push({ requested: 'typescript@5.9.2', findings: [] });
	report.summary.packagesAudited = 3;
	const result = check(report, 1, '9.39.5', { typescript: '5.9.2' });
	assert.equal(result.status, 0, result.stderr);
});

for (const [name, edit] of [
	[
		'another ESLint error',
		(report) => {
			report.packages[0].findings[0].marshall = 'snyk';
		},
	],
	[
		'another deprecation message',
		(report) => {
			report.packages[0].findings[0].message = 'Package repository has been archived on GitHub';
		},
	],
	[
		'another package error',
		(report) => {
			report.packages[1].findings.push({ ...deprecated });
			report.summary.errors += 1;
		},
	],
	[
		'an operational failure',
		(report) => {
			report.failures.push({ code: 'AUDIT_CHECK_FAILED', message: 'Registry unavailable' });
			report.status = 'failed';
		},
	],
	[
		'missing package coverage',
		(report) => {
			report.packages.pop();
			report.summary.packagesAudited = 1;
		},
	],
	[
		'duplicate package coverage',
		(report) => {
			report.packages[1] = structuredClone(report.packages[0]);
			report.summary.errors = 2;
		},
	],
	[
		'an unknown severity',
		(report) => {
			report.packages[1].findings.push({ ...deprecated, severity: 'notice' });
		},
	],
	[
		'an inconsistent summary',
		(report) => {
			report.summary.errors = 0;
		},
	],
	[
		'a changed report schema',
		(report) => {
			report.schemaVersion = 2;
		},
	],
	[
		'a changed audit tool',
		(report) => {
			report.tool.version = '3.28.0';
		},
	],
	[
		'an inconsistent report status',
		(report) => {
			report.status = 'clean';
		},
	],
]) {
	test(`rejects ${name}`, () => {
		const report = audit();
		edit(report);
		assert.equal(check(report).status, 1);
	});
}

test('rejects the deprecation for a different ESLint version', () => {
	const report = audit();
	report.packages[0].requested = 'eslint@9.39.6';
	assert.equal(check(report, 1, '9.39.6').status, 1);
});

test('rejects an unsuccessful audit process', () => {
	assert.equal(check(audit(), 2).status, 1);
});
