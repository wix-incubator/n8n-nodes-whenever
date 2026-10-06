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
		if (response.disconnect || response.disconnectAt === requests.length) {
			reply.destroy();
			return;
		}
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

function context(
	inputs = ['{"message":"Hello","nested":{"count":2}}'],
	overrides = {},
	inputFormat = 'json',
) {
	const nodeContext = {};
	return {
		getContext: () => nodeContext,
		getExecutionId: () => 'execution-1',
		getInstanceId: () => 'instance-1',
		getWorkflow: () => ({ id: 'workflow-1' }),
		getWorkflowDataProxy: () => ({ $runIndex: 0 }),
		getInputData: () => inputs.map(() => ({ json: {} })),
		getNodeParameter: (name, index, fallback) => {
			if (name === 'authentication') return fallback;
			if (name === 'input' || name === 'textInput' || name === 'formFields') return inputs[index];
			if (name === 'inputFormat') return inputFormat;
			if (name === 'operation') return 'start';
			throw new Error(`Unexpected parameter: ${name}`);
		},
		getCredentials: async () => ({ webhookUrl }),
		getNode: () => ({
			id: 'whenever-1',
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

const execute = (inputs, overrides, inputFormat) =>
	new Whenever().execute.call(context(inputs, overrides, inputFormat));

for (const [format, input] of [
	['plain text', 'Hello, Živilė!\nSecond line'],
	['CSV', 'name,amount\nSam,25'],
	['XML', '<order><amount>25</amount></order>'],
	['JSON-looking text', '{"amount":25}'],
]) {
	test(`sends ${format} unchanged as text`, async () => {
		const result = await execute([input], {}, 'text');
		assert.equal(requests[0].headers['content-type'], 'text/plain');
		assert.equal(requests[0].body, input);
		assert.equal(result[0][0].json.runId, 'run-123');
	});
}

test('sends a numeric text expression as its decimal text', async () => {
	await execute([42], {}, 'text');
	assert.equal(requests[0].body, '42');
});

test('rejects an object text expression before making a request', async () => {
	await assert.rejects(execute([{ amount: 25 }], {}, 'text'), /Text Input must be text/);
	assert.equal(requests.length, 0);
});

test('encodes form names and values without losing special characters or empty values', async () => {
	const result = await execute(
		[
			{
				values: [
					{ name: 'customer & tier', value: 'Sam + Živilė' },
					{ name: 'message', value: 'a=b&c' },
					{ name: 'empty', value: '' },
					{ name: 'amount', value: 25 },
				],
			},
		],
		{},
		'form',
	);
	assert.equal(requests[0].headers['content-type'], 'application/x-www-form-urlencoded');
	assert.equal(
		requests[0].body,
		'customer+%26+tier=Sam+%2B+%C5%BDivil%C4%97&message=a%3Db%26c&empty=&amount=25',
	);
	assert.equal(result[0][0].json.runId, 'run-123');
});

test('rejects an object form value before making a request', async () => {
	await assert.rejects(
		execute([{ values: [{ name: 'order', value: { amount: 25 } }] }], {}, 'form'),
		/Form field value must be text/,
	);
	assert.equal(requests.length, 0);
});

test('sends the form values for each incoming item separately', async () => {
	const result = await execute(
		[{ values: [{ name: 'amount', value: '25' }] }, { values: [{ name: 'amount', value: '50' }] }],
		{},
		'form',
	);
	assert.deepEqual(
		requests.map((request) => request.body),
		['amount=25', 'amount=50'],
	);
	assert.deepEqual(
		result[0].map((item) => item.pairedItem),
		[{ item: 0 }, { item: 1 }],
	);
});

test('uses different idempotency keys for new executions with identical JSON', async () => {
	await execute(undefined, { getExecutionId: () => 'execution-1' });
	await execute(undefined, { getExecutionId: () => 'execution-2' });
	const keys = requests.map((request) => request.headers['idempotency-key']);
	assert.equal(requests[0].body, requests[1].body);
	for (const key of keys) assert.equal(typeof key, 'string');
	assert.notEqual(keys[0], keys[1]);
});

test('reuses the delivery key when n8n retries a saved failed execution under a new ID', async () => {
	let nodeContext = {};
	response = { status: 500, body: {} };
	await assert.rejects(
		execute(undefined, {
			getContext: () => nodeContext,
			getExecutionId: () => 'original-execution',
		}),
		/HTTP 500/,
	);
	nodeContext = JSON.parse(JSON.stringify(nodeContext));
	response = { status: 200, body: { runId: 'original-run' } };
	const result = await execute(undefined, {
		getContext: () => nodeContext,
		getExecutionId: () => 'retry-execution',
	});
	assert.equal(requests[1].headers['idempotency-key'], requests[0].headers['idempotency-key']);
	assert.equal(result[0][0].json.runId, 'original-run');
});

test('reuses the delivery key after a lost response during Retry On Fail', async () => {
	const executionContext = context();
	response = { disconnect: true };
	await assert.rejects(new Whenever().execute.call(executionContext), /could not confirm/);
	response = { status: 200, body: { runId: 'accepted-before-disconnect' } };
	const result = await new Whenever().execute.call(executionContext);
	assert.equal(requests.length, 2);
	assert.equal(requests[1].headers['idempotency-key'], requests[0].headers['idempotency-key']);
	assert.equal(result[0][0].json.runId, 'accepted-before-disconnect');
});

test('reuses distinct item keys when a partially delivered batch is retried', async () => {
	const executionContext = context(['{"message":"same"}', '{"message":"same"}']);
	response.disconnectAt = 2;
	await assert.rejects(new Whenever().execute.call(executionContext), /could not confirm/);
	response = { status: 200, body: { runId: 'original-run' } };
	await new Whenever().execute.call(executionContext);
	const keys = requests.map((request) => request.headers['idempotency-key']);
	assert.notEqual(keys[0], keys[1]);
	assert.deepEqual(keys.slice(2), keys.slice(0, 2));
});

test('uses distinct keys for separate loop iterations in one execution', async () => {
	const nodeContext = {};
	for (const runIndex of [0, 1]) {
		await execute(undefined, {
			getContext: () => nodeContext,
			getWorkflowDataProxy: () => ({ $runIndex: runIndex }),
		});
	}
	assert.notEqual(requests[0].headers['idempotency-key'], requests[1].headers['idempotency-key']);
});

test('uses distinct keys for two Whenever nodes calling the same endpoint', async () => {
	for (const nodeId of ['first-node', 'second-node']) {
		await execute(undefined, { getNode: () => ({ ...context().getNode(), id: nodeId }) });
	}
	assert.notEqual(requests[0].headers['idempotency-key'], requests[1].headers['idempotency-key']);
});

test('isolates keys when separate n8n instances have the same execution IDs', async () => {
	await execute(undefined, { getInstanceId: () => 'first-instance' });
	await execute(undefined, { getInstanceId: () => 'second-instance' });
	assert.notEqual(requests[0].headers['idempotency-key'], requests[1].headers['idempotency-key']);
});

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

for (const status of [400, 401, 403, 404]) {
	test(`tells the user to check the webhook and input on HTTP ${status}`, async () => {
		response = { status, body: { runId: 'not-accepted' } };
		await assert.rejects(execute(), (error) => {
			assert.match(error.message, new RegExp(`rejected the request \\(HTTP ${status}\\)`));
			assert.match(error.description, /Check the webhook URL and input/);
			return true;
		});
	});
}

for (const status of [429, 500, 503]) {
	test(`tells the user to retry on HTTP ${status}`, async () => {
		response = { status, body: { runId: 'not-accepted' } };
		await assert.rejects(execute(), (error) => {
			assert.match(error.message, new RegExp(`could not process the request \\(HTTP ${status}\\)`));
			assert.match(error.description, /Retry later/);
			return true;
		});
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

test('rejects an undefined JSON expression before making a request', async () => {
	await assert.rejects(execute([undefined]), /valid JSON/);
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

test('reports the transport error code without the webhook URL', async () => {
	await assert.rejects(
		execute(undefined, {
			helpers: {
				httpRequestWithAuthentication: async () => {
					throw Object.assign(new Error(`connect ECONNREFUSED ${webhookUrl}`), {
						code: 'ECONNREFUSED',
					});
				},
			},
		}),
		(error) => {
			assert.match(error.message, /could not confirm/i);
			assert.match(error.description, /\(ECONNREFUSED\)$/);
			assert.equal(JSON.stringify(error).includes('test-secret'), false);
			return true;
		},
	);
});

test('reports a transport error code wrapped in a cause', async () => {
	await assert.rejects(
		execute(undefined, {
			helpers: {
				httpRequestWithAuthentication: async () => {
					throw new Error('request failed', { cause: { code: 'ETIMEDOUT' } });
				},
			},
		}),
		(error) => {
			assert.match(error.description, /\(ETIMEDOUT\)$/);
			return true;
		},
	);
});

test('hides a transport failure that carries no error code', async () => {
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
			assert.equal(error.description, 'Check Whenever before retrying. A run may have started.');
			assert.equal(JSON.stringify(error).includes('test-secret'), false);
			return true;
		},
	);
});

test('keeps the message of an unexpected error', async () => {
	await assert.rejects(
		execute(undefined, {
			getNodeParameter: () => {
				throw new Error('parameter store exploded');
			},
		}),
		/parameter store exploded/,
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
	'https://example.com/hooks#fragment',
]) {
	test(`rejects an invalid webhook URL without sending a request: ${webhookUrl}`, async () => {
		await assert.rejects(
			execute(undefined, { getCredentials: async () => ({ webhookUrl }) }),
			/Webhook URL/,
		);
		assert.equal(requests.length, 0);
	});
}
