import { createServer } from 'node:http';

export async function mcpServer(t, respond) {
	const requests = [];
	const server = createServer(async (request, reply) => {
		let text = '';
		for await (const chunk of request) text += chunk;
		const body = JSON.parse(text);
		requests.push({ body, headers: request.headers });
		const result = await respond(body, requests.length);
		reply.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
		reply.end(JSON.stringify(result.body));
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const url = `http://127.0.0.1:${server.address().port}`;
	const options = [];
	const context = (parameters = {}, items = [{}]) => ({
		getNode: () => ({ id: 'whenever-account', name: 'Whenever', typeVersion: 1, parameters }),
		getInputData: () => items.map((json) => ({ json })),
		getCredentials: async () => ({ webhookUrl: url }),
		getContext: () => ({}),
		getExecutionId: () => 'execution-1',
		getInstanceId: () => 'instance-1',
		getWorkflow: () => ({ id: 'workflow-1' }),
		getWorkflowDataProxy: () => ({ $runIndex: 0 }),
		getNodeParameter: (name, index, fallback) => {
			const value = parameters[name] ?? { inputFormat: 'json', input: '{}' }[name] ?? fallback;
			return typeof value === 'function' ? value(index) : value;
		},
		continueOnFail: () => false,
		helpers: {
			httpRequestWithAuthentication: async (credentialType, request) => {
				options.push({ credentialType, ...request });
				const response = await fetch(url, {
					method: request.method,
					headers: { ...request.headers, Authorization: 'Bearer test-account-token' },
					body: JSON.stringify(request.body),
					redirect: request.disableFollowRedirect ? 'manual' : 'follow',
				});
				return { statusCode: response.status, body: await response.json() };
			},
		},
	});
	const loadContext = (parameters = {}) => ({
		...context(parameters),
		getNodeParameter: (name, fallback, options) => {
			const value = parameters[name] ?? fallback;
			return options?.extractValue && value !== null && typeof value === 'object' ? value.value : value;
		},
	});
	return { requests, options, context, loadContext };
}

export function toolResult(result, id = 1) {
	return { body: { jsonrpc: '2.0', id, result: { structuredContent: { result } } } };
}
