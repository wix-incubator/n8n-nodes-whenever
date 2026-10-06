import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Whenever } from '../dist/nodes/Whenever/Whenever.node.js';
import { mcpServer, toolResult } from './mcp-testkit.mjs';

const execute = (context) => new Whenever().execute.call(context);
const account = {
	isLoggedIn: true,
	email: 'owner@example.test',
	displayName: 'Owner',
	photoUrl: null,
};

test('refuses account operations with a webhook connection before making a request', async (t) => {
	const service = await mcpServer(t, () => ({ body: { runId: 'unexpected-run' } }));
	await assert.rejects(
		execute(service.context({ authentication: 'webhook', operation: 'getAccount' })),
		/Start Workflow/,
	);
	assert.deepEqual(service.requests, []);
});

for (const body of [
	{ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'private detail' } },
	{ jsonrpc: '2.0', id: 2, result: { structuredContent: { result: account } } },
	{ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }] } },
]) {
	test(`rejects invalid account evidence: ${JSON.stringify(body)}`, async (t) => {
		const service = await mcpServer(t, () => ({ body }));
		await assert.rejects(
			execute(service.context({ authentication: 'account', operation: 'getAccount' })),
			/MCP response|structured account data/,
		);
	});
}

test('reads the connected account without starting a workflow', async (t) => {
	const service = await mcpServer(t, () => toolResult(account));
	const result = await execute(
		service.context({ authentication: 'account', operation: 'getAccount' }),
	);
	assert.deepEqual(result, [[{ json: account, pairedItem: { item: 0 } }]]);
	assert.deepEqual(
		service.requests.map(({ body }) => body.params),
		[{ name: 'get_current_user', arguments: {} }],
	);
	assert.equal(service.options[0].url, 'https://mcp.whenever.dev/');
	assert.equal(service.options[0].credentialType, 'wheneverOAuth2Api');
	assert.equal(service.options[0].disableFollowRedirect, true);
});

test('accepts an authenticated account whose profile fields are unavailable', async (t) => {
	const service = await mcpServer(t, () =>
		toolResult({ isLoggedIn: true, email: null, displayName: null, photoUrl: null }),
	);
	const result = await execute(
		service.context({ authentication: 'account', operation: 'getAccount' }),
	);
	assert.equal(result[0][0].json.isLoggedIn, true);
	assert.equal(result[0][0].json.email, null);
});

test('asks for reconnection after the account token expires', async (t) => {
	const service = await mcpServer(t, () => ({ status: 401, body: { error: 'invalid_token' } }));
	await assert.rejects(
		execute(service.context({ authentication: 'account', operation: 'getAccount' })),
		/Reconnect/,
	);
});

test('rejects a refused MCP tool result even when HTTP succeeds', async (t) => {
	const response = toolResult({ code: 'NO_WIX_SESSION', message: 'private upstream detail' });
	response.body.result.isError = true;
	const service = await mcpServer(t, () => response);
	await assert.rejects(
		execute(service.context({ authentication: 'account', operation: 'getAccount' })),
		(error) => {
			assert.match(error.message, /refused/);
			assert.doesNotMatch(error.message, /private upstream detail/);
			return true;
		},
	);
});

test('rejects an account response that does not establish a signed-in account', async (t) => {
	const service = await mcpServer(t, () => toolResult({ ...account, isLoggedIn: false }));
	await assert.rejects(
		execute(service.context({ authentication: 'account', operation: 'getAccount' })),
		/signed-in/,
	);
});

test('returns a safe error item on account transport failure with Continue On Fail', async (t) => {
	const service = await mcpServer(t, () => toolResult(account));
	const context = service.context({ authentication: 'account', operation: 'getAccount' });
	context.continueOnFail = () => true;
	context.helpers.httpRequestWithAuthentication = async () => {
		throw new Error('Authorization: Bearer private-token');
	};
	const result = await execute(context);
	assert.match(result[0][0].json.error, /could not read/);
	assert.doesNotMatch(JSON.stringify(result), /private-token/);
	assert.deepEqual(result[0][0].pairedItem, { item: 0 });
});
