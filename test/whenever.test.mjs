import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { Whenever } from '../dist/nodes/Whenever/Whenever.node.js';

let server;
let webhookUrl;
let requests;
let response;

before(async () => {
	server = createServer(async (request, reply) => {
		let body = '';
		for await (const chunk of request) body += chunk;
		requests.push({ method: request.method, path: request.url, headers: request.headers, body });
		reply.writeHead(response.status, { 'content-type': 'application/json', ...response.headers });
		reply.end(typeof response.body === 'string' ? response.body : JSON.stringify(response.body));
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	webhookUrl = `http://127.0.0.1:${server.address().port}/hooks/generic/test-secret`;
});
after(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => {
	requests = [];
	response = { status: 202, body: { runId: 'run-123' } };
});

function context(inputs = ['{"message":"Hello","nested":{"count":2}}'], overrides = {}) {
	return {
		getInputData: () => inputs.map(() => ({ json: {} })),
		getNodeParameter: (name, index) => {
			if (name === 'input') return inputs[index];
			if (name === 'operation') return 'start';
			throw new Error(`Unexpected parameter: ${name}`);
		},
		getCredentials: async () => ({ webhookUrl }),
		getNode: () => ({
			name: 'Whenever',
			type: 'n8n-nodes-whenever.whenever',
			typeVersion: 1,
			position: [0, 0],
			parameters: {},
		}),
		continueOnFail: () => false,
		helpers: {
			httpRequestWithAuthentication: async (_credentialType, options) => {
				const result = await fetch(options.url, {
					method: options.method,
					headers: options.headers,
					body: options.body,
					redirect: options.disableFollowRedirect ? 'manual' : 'follow',
				});
				return {
					statusCode: result.status,
					body: await result.text(),
					headers: Object.fromEntries(result.headers),
				};
			},
		},
		...overrides,
	};
}

const execute = (inputs, overrides) => new Whenever().execute.call(context(inputs, overrides));

test('sends the JSON input to the configured webhook as a POST', async () => {
	await execute();
	assert.equal(requests.length, 1);
	assert.equal(requests[0].method, 'POST');
	assert.equal(requests[0].path, '/hooks/generic/test-secret');
	assert.equal(requests[0].headers['Content-Type'.toLowerCase()], 'application/json');
	assert.deepEqual(JSON.parse(requests[0].body), { message: 'Hello', nested: { count: 2 } });
});

test('returns the accepted runId without claiming workflow completion', async () => {
	response.body = { runId: 'run-123', status: 'success', result: 'untrusted extra data' };
	assert.deepEqual(await execute(), [[{ json: { runId: 'run-123' }, pairedItem: { item: 0 } }]]);
});

test('returns the existing runId for a deduplicated delivery', async () => {
	response.status = 200;
	assert.equal((await execute())[0][0].json.runId, 'run-123');
});

for (const status of [400, 401, 403, 404, 429, 500, 503]) {
	test(`shows an error when Whenever rejects the request with HTTP ${status}`, async () => {
		response = { status, body: { runId: 'not-accepted' } };
		await assert.rejects(execute(), new RegExp(`HTTP ${status}`));
	});
}

for (const body of [{}, { runId: '' }, { runId: '  ' }, { runId: 42 }, null, 'not JSON']) {
	test(`does not claim acceptance for an invalid response: ${JSON.stringify(body)}`, async () => {
		response = { status: 200, body };
		await assert.rejects(execute(), /runId/);
	});
}

test('rejects malformed input before making a request', async () => {
	await assert.rejects(execute(['{invalid']), /valid JSON/);
	assert.equal(requests.length, 0);
});

test('accepts a JSON object supplied by an n8n expression', async () => {
	await execute([{ message: 'expression', items: [1, false, null] }]);
	assert.deepEqual(JSON.parse(requests[0].body), {
		message: 'expression',
		items: [1, false, null],
	});
});

test('preserves JSON arrays and scalar input', async () => {
	await execute(['[1,"two"]', 'null', 'false', '42', '"hello"']);
	assert.deepEqual(
		requests.map((request) => JSON.parse(request.body)),
		[[1, 'two'], null, false, 42, 'hello'],
	);
});

test('sends each incoming item and links each receipt to that item', async () => {
	const result = await execute(['{"item":1}', '{"item":2}']);
	assert.deepEqual(
		requests.map((request) => JSON.parse(request.body)),
		[{ item: 1 }, { item: 2 }],
	);
	assert.deepEqual(
		result[0].map((item) => item.pairedItem),
		[{ item: 0 }, { item: 1 }],
	);
});

test('hides the webhook URL when the transport fails', async () => {
	await assert.rejects(
		execute(undefined, {
			helpers: {
				httpRequestWithAuthentication: async () => {
					throw new Error(`Cannot connect to ${webhookUrl}`);
				},
			},
		}),
		(error) => {
			assert.match(error.message, /could not confirm/i);
			assert.equal(JSON.stringify(error).includes('test-secret'), false);
			return true;
		},
	);
});

test('does not follow a redirect or report it as acceptance', async () => {
	response = {
		status: 302,
		body: { runId: 'not-accepted' },
		headers: { location: '/other-endpoint' },
	};
	await assert.rejects(execute(), /HTTP 302/);
	assert.equal(requests.length, 1);
});

test('returns an error item when n8n Continue On Fail is enabled', async () => {
	response = { status: 403, body: {} };
	const result = await execute(undefined, { continueOnFail: () => true });
	assert.match(result[0][0].json.error, /HTTP 403/);
	assert.equal(result[0][0].json.runId, undefined);
	assert.deepEqual(result[0][0].pairedItem, { item: 0 });
});

for (const webhookUrl of [
	'',
	'not a URL',
	'file:///tmp/workflow',
	'https://user:password@example.com/hooks',
]) {
	test(`rejects an invalid webhook URL without sending a request: ${webhookUrl}`, async () => {
		await assert.rejects(
			execute(undefined, { getCredentials: async () => ({ webhookUrl }) }),
			/Webhook URL/,
		);
		assert.equal(requests.length, 0);
	});
}
