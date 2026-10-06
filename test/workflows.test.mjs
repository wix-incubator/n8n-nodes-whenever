import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Whenever } from '../dist/nodes/Whenever/Whenever.node.js';
import { mcpServer, toolResult } from './mcp-testkit.mjs';

const webhook = {
	endpointId: 'hook-1',
	integration: 'generic',
	enabled: true,
	url: 'https://hooks.example.test/hooks/generic/secret',
	name: 'Lead received',
};
const parameters = {
	authentication: 'account',
	operation: 'start',
	workflowId: 'workflow-1',
	webhookId: 'hook-1',
	inputFormat: 'json',
	input: '{"lead":"Ada"}',
};

test('finds an owned workflow by name without exposing unrelated account fields', async (t) => {
	const service = await mcpServer(t, () =>
		toolResult({
			workflows: [
				{ id: 'workflow-1', name: 'Score leads', deployedVersion: 3, ownerId: 'private-owner' },
				{ id: 'workflow-2', name: 'Daily report' },
			],
			completeness: 'complete',
		}),
	);
	const result = await new Whenever().methods?.listSearch?.getWorkflows?.call(
		service.loadContext(),
		'SCORE',
	);
	assert.deepEqual(result, { results: [{ name: 'Score leads', value: 'workflow-1' }] });
	assert.deepEqual(service.requests[0].body.params, { name: 'list_workflows', arguments: {} });
});

test('offers only enabled generic webhooks for the selected workflow', async (t) => {
	const service = await mcpServer(t, () =>
		toolResult({
			endpoints: [
				webhook,
				{ ...webhook, endpointId: 'paused', enabled: false },
				{ ...webhook, endpointId: 'stripe', integration: 'stripe' },
			],
		}),
	);
	const result = await new Whenever().methods?.loadOptions?.getWebhooks?.call(
		service.loadContext({ ...parameters, workflowId: { __rl: true, mode: 'list', value: 'workflow-1' } }),
	);
	assert.deepEqual(result, [{ name: 'Lead received', value: 'hook-1' }]);
	assert.deepEqual(service.requests[0].body.params.arguments, { workflow_id: 'workflow-1' });
});

test('starts the selected webhook without forwarding the account token', async (t) => {
	const service = await mcpServer(t, () => toolResult({ endpoints: [webhook] }));
	const context = service.context(parameters);
	const deliveries = [];
	context.helpers.httpRequest = async (request) => {
		deliveries.push(request);
		return { statusCode: 202, body: { runId: 'run-1' } };
	};
	const result = await new Whenever().execute.call(context);
	assert.deepEqual(result, [[{ json: { runId: 'run-1' }, pairedItem: { item: 0 } }]]);
	assert.equal(deliveries[0].url, webhook.url);
	assert.equal(deliveries[0].body, '{"lead":"Ada"}');
	assert.equal(deliveries[0].headers.Authorization, undefined);
	assert.equal(deliveries[0].headers['Idempotency-Key'].length, 64);
	assert.deepEqual(
		service.options.map(({ credentialType }) => credentialType),
		['wheneverOAuth2Api'],
	);
});

for (const endpoint of [
	{ ...webhook, enabled: false },
	{ ...webhook, integration: 'stripe' },
	{ ...webhook, endpointId: 'another-hook' },
	{ ...webhook, url: 'file:///private/secret' },
	{ ...webhook, url: 'https://user:secret@example.test/' },
]) {
	test(`refuses an unavailable or invalid selected endpoint: ${endpoint.endpointId} ${endpoint.integration} ${endpoint.enabled} ${endpoint.url}`, async (t) => {
		const service = await mcpServer(t, () => toolResult({ endpoints: [endpoint] }));
		const context = service.context(parameters);
		let delivered = false;
		context.helpers.httpRequest = async () => {
			delivered = true;
			return { statusCode: 202, body: { runId: 'unexpected' } };
		};
		await assert.rejects(new Whenever().execute.call(context), /webhook/i);
		assert.equal(delivered, false);
	});
}

test('keeps missing workflow selection from making any account or webhook request', async (t) => {
	const service = await mcpServer(t, () => toolResult({ endpoints: [webhook] }));
	await assert.rejects(
		new Whenever().execute.call(service.context({ ...parameters, workflowId: '' })),
		/workflow/i,
	);
	assert.deepEqual(service.requests, []);
});
