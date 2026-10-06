import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Whenever } from '../dist/nodes/Whenever/Whenever.node.js';
import { mcpServer, toolResult } from './mcp-testkit.mjs';

const parameters = {
	authentication: 'account',
	operation: 'getRun',
	runId: 'run-1',
	afterSeq: 0,
	eventLimit: 100,
};
const run = {
	runId: 'run-1',
	workflowId: 'workflow-1',
	version: '3',
	status: 'succeeded',
	startedAt: 1000,
	endedAt: 2000,
};
const success = {
	runId: 'run-1',
	seq: 2,
	ts: 2000,
	type: 'run_succeeded',
	outputJson: '{"score":82}',
};
const snapshot = (overrides = {}) => ({
	run,
	events: [success],
	nextSeq: 2,
	nextCursor: null,
	truncated: false,
	...overrides,
});
const execute = (context) => new Whenever().execute.call(context);

test('returns parsed output from a successful run', async (t) => {
	const service = await mcpServer(t, () => toolResult(snapshot()));
	const result = await execute(service.context(parameters));
	assert.equal(result[0][0].json.status, 'succeeded');
	assert.deepEqual(result[0][0].json.output, { score: 82 });
	assert.equal(result[0][0].json.outputState, 'available');
	assert.equal(result[0][0].json.hasMoreEvents, false);
	assert.deepEqual(service.requests[0].body.params, {
		name: 'get_run',
		arguments: { run_id: 'run-1', after_seq: 0, limit: 100 },
	});
});

test('returns a running snapshot without claiming output', async (t) => {
	const service = await mcpServer(t, () =>
		toolResult(
			snapshot({ run: { ...run, status: 'running', endedAt: undefined }, events: [], nextSeq: 0 }),
		),
	);
	const result = (await execute(service.context(parameters)))[0][0].json;
	assert.equal(result.status, 'running');
	assert.equal(result.outputState, 'not_observed');
	assert.equal(Object.hasOwn(result, 'output'), false);
});

test('preserves completion output while the run summary still says running', async (t) => {
	const service = await mcpServer(t, () =>
		toolResult(snapshot({ run: { ...run, status: 'running', endedAt: undefined } })),
	);
	const result = (await execute(service.context(parameters)))[0][0].json;
	assert.equal(result.status, 'running');
	assert.equal(result.nextSeq, 2);
	assert.equal(result.outputState, 'available');
	assert.deepEqual(result.output, { score: 82 });
});

test('preserves incomplete observation even when the stored status is terminal', async (t) => {
	const service = await mcpServer(t, () => toolResult(snapshot({ observationComplete: false })));
	const result = (await execute(service.context(parameters)))[0][0].json;
	assert.equal(result.observationComplete, false);
	assert.equal(result.status, 'succeeded');
});

test('reads a later event page using the caller cursor', async (t) => {
	const service = await mcpServer(t, () =>
		toolResult(snapshot({ events: [{ ...success, seq: 102 }], nextSeq: 102 })),
	);
	const result = (await execute(service.context({ ...parameters, afterSeq: 100 })))[0][0].json;
	assert.deepEqual(service.requests[0].body.params.arguments, {
		run_id: 'run-1',
		after_seq: 100,
		limit: 100,
	});
	assert.equal(result.nextSeq, 102);
	assert.deepEqual(result.output, { score: 82 });
});

test('keeps a truncated page distinct from a run that returned no value', async (t) => {
	const service = await mcpServer(t, () =>
		toolResult(
			snapshot({
				events: [{ runId: 'run-1', seq: 1, type: 'log', ts: 1100, message: 'Started' }],
				nextSeq: 1,
				nextCursor: 'page-2',
				truncated: true,
			}),
		),
	);
	const result = (await execute(service.context(parameters)))[0][0].json;
	assert.equal(result.hasMoreEvents, true);
	assert.equal(result.nextSeq, 1);
	assert.equal(result.outputState, 'not_observed');
});

test('reports omitted output without pretending the result is empty', async (t) => {
	const service = await mcpServer(t, () =>
		toolResult(
			snapshot({ events: [{ ...success, outputJson: undefined, outputOmitted: 'too_large' }] }),
		),
	);
	const result = (await execute(service.context(parameters)))[0][0].json;
	assert.equal(result.outputState, 'omitted');
	assert.equal(result.outputOmitted, 'too_large');
	assert.equal(Object.hasOwn(result, 'output'), false);
});

test('distinguishes a successful run with no return value', async (t) => {
	const service = await mcpServer(t, () =>
		toolResult(snapshot({ events: [{ ...success, outputJson: undefined }] })),
	);
	const result = (await execute(service.context(parameters)))[0][0].json;
	assert.equal(result.outputState, 'none');
	assert.equal(Object.hasOwn(result, 'output'), false);
});

for (const value of [null, false, 0, '', [1, 2]]) {
	test(`preserves JSON output ${JSON.stringify(value)}`, async (t) => {
		const service = await mcpServer(t, () =>
			toolResult(snapshot({ events: [{ ...success, outputJson: JSON.stringify(value) }] })),
		);
		const result = (await execute(service.context(parameters)))[0][0].json;
		assert.deepEqual(result.output, value);
		assert.equal(result.outputState, 'available');
	});
}

for (const status of ['failed', 'timed_out', 'cancelled']) {
	test(`returns ${status} as run evidence rather than a request failure`, async (t) => {
		const failure = { code: 'PROVIDER_ERROR', message: 'Provider refused the operation' };
		const service = await mcpServer(t, () =>
			toolResult(snapshot({ run: { ...run, status, failure }, events: [] })),
		);
		const result = (await execute(service.context(parameters)))[0][0].json;
		assert.equal(result.status, status);
		assert.deepEqual(result.failure, failure);
		assert.equal(Object.hasOwn(result, 'error'), false);
	});
}

for (const [name, data] of [
	['wrong run', snapshot({ run: { ...run, runId: 'another-run' } })],
	['unknown status', snapshot({ run: { ...run, status: 'accepted' } })],
	['malformed output', snapshot({ events: [{ ...success, outputJson: 'not JSON' }] })],
	['foreign event', snapshot({ events: [{ ...success, runId: 'another-run' }] })],
	[
		'nonadvancing page',
		snapshot({ events: [], nextSeq: 0, truncated: true, nextCursor: 'page-2' }),
	],
	['missing page evidence', snapshot({ truncated: undefined })],
]) {
	test(`rejects invalid run evidence: ${name}`, async (t) => {
		const service = await mcpServer(t, () => toolResult(data));
		await assert.rejects(execute(service.context(parameters)), /invalid|Invalid/);
	});
}

test('validates the event limit before making an account request', async (t) => {
	const service = await mcpServer(t, () => toolResult(snapshot()));
	await assert.rejects(execute(service.context({ ...parameters, eventLimit: 101 })), /limit/i);
	assert.deepEqual(service.requests, []);
});
