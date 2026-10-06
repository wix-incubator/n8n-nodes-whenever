import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const template = JSON.parse(
	await readFile(new URL('../examples/start-and-handle-result.json', import.meta.url), 'utf8'),
);
const evaluator = template.nodes.find((node) => node.name === 'Evaluate result').parameters.jsCode;
const state = {
	runId: 'run-1',
	afterSeq: 0,
	reads: 0,
	deadline: 301000,
	outputState: 'not_observed',
};
const running = {
	runId: 'run-1',
	status: 'running',
	nextSeq: 1,
	hasMoreEvents: false,
	outputState: 'not_observed',
};
const evaluate = (read, previous = state, now = 1000) =>
	new Function('$json', '$', 'Date', evaluator)(read, () => ({ item: { json: previous } }), {
		now: () => now,
	}).json;

test('waits before reading a running workflow again', () => {
	const result = evaluate(running);
	assert.equal(result.route, 'wait');
	assert.equal(result.reads, 1);
	assert.equal(result.afterSeq, 1);
});

test('routes a successful result to the output branch', () => {
	const result = evaluate({
		...running,
		status: 'succeeded',
		outputState: 'available',
		output: { score: 82 },
	});
	assert.equal(result.route, 'success');
	assert.deepEqual(result.output, { score: 82 });
});

test('waits for another event page even if the run already succeeded', () => {
	const result = evaluate({ ...running, status: 'succeeded', hasMoreEvents: true });
	assert.equal(result.route, 'wait');
});

test('preserves output read before the final event page', () => {
	const first = evaluate({
		...running,
		status: 'succeeded',
		hasMoreEvents: true,
		outputState: 'available',
		output: false,
	});
	const final = evaluate({ ...running, status: 'succeeded', nextSeq: 2 }, first);
	assert.equal(final.route, 'success');
	assert.equal(final.output, false);
});

test('does not settle terminal status while observation is incomplete', () => {
	const result = evaluate({ ...running, status: 'failed', observationComplete: false });
	assert.equal(result.route, 'wait');
});

for (const status of ['failed', 'timed_out', 'cancelled']) {
	test(`routes ${status} to the failure branch`, () => {
		assert.equal(evaluate({ ...running, status }).route, 'failed');
	});
}

for (const outputState of ['omitted', 'none', 'not_observed']) {
	test(`routes ${outputState} output separately from an available result`, () => {
		assert.equal(evaluate({ ...running, status: 'succeeded', outputState }).route, 'missing');
	});
}

test('stops observing at the deadline without changing the recorded run status', () => {
	const result = evaluate(running, state, state.deadline);
	assert.equal(result.route, 'timeout');
	assert.equal(result.status, 'running');
	assert.equal(result.runId, 'run-1');
});

test('stops after 120 reads even when the deadline has not elapsed', () => {
	assert.equal(evaluate(running, { ...state, reads: 119 }).route, 'timeout');
});

test('continues reading the existing run without reconnecting to Start workflow', () => {
	const waitPath = template.connections['Route result'].main[0][0].node;
	const statePath = template.connections[waitPath].main[0][0].node;
	const readPath = template.connections[statePath].main[0][0].node;
	assert.equal(template.nodes.find((node) => node.name === waitPath).type, 'n8n-nodes-base.wait');
	assert.equal(
		template.nodes.find((node) => node.name === readPath).parameters.operation,
		'getRun',
	);
});
