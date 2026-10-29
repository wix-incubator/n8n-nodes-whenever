import type { IDataObject, IExecuteFunctions, ILoadOptionsFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

export function objectValue(value: unknown): value is IDataObject {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function arrayOf<T>(value: unknown, isItem: (item: unknown) => item is T): T[] | undefined {
	return Array.isArray(value) && value.every(isItem) ? value : undefined;
}

export async function callTool(
	context: IExecuteFunctions | ILoadOptionsFunctions,
	name: string,
	args: IDataObject = {},
	itemIndex?: number,
): Promise<IDataObject> {
	const fail = (message: string) =>
		new NodeOperationError(context.getNode(), message, { itemIndex });

	let response: { statusCode: number; body: unknown };
	try {
		response = await context.helpers.httpRequestWithAuthentication.call(
			context,
			'wheneverOAuth2Api',
			{
				method: 'POST',
				url: 'https://mcp.whenever.dev/',
				headers: {
					Accept: 'application/json, text/event-stream',
					'MCP-Protocol-Version': '2025-03-26',
				},
				body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
				json: true,
				returnFullResponse: true,
				ignoreHttpStatusErrors: { ignore: true, except: [401] },
				disableFollowRedirect: true,
				timeout: 30000,
			},
		);
	} catch {
		throw fail(
			'Whenever could not be reached. Reconnect your account if its authorization expired.',
		);
	}
	if (response.statusCode < 200 || response.statusCode >= 300) {
		throw fail(`Whenever rejected the request (HTTP ${response.statusCode}).`);
	}

	const body = response.body;
	if (
		!objectValue(body) ||
		body.jsonrpc !== '2.0' ||
		body.id !== 1 ||
		body.error !== undefined ||
		!objectValue(body.result)
	) {
		throw fail('Whenever returned an invalid MCP response.');
	}
	const content = body.result.structuredContent;
	if (body.result.isError === true) {
		const refusal = objectValue(content) && objectValue(content.result) ? content.result : undefined;
		if (refusal?.code === 'RUN_NOT_FOUND') {
			throw fail(
				'Whenever could not find this run for the connected account (RUN_NOT_FOUND). Check the run ID.',
			);
		}
		if (refusal?.code === 'NO_WIX_SESSION') {
			throw fail('Whenever refused account access (NO_WIX_SESSION). Reconnect your Whenever account.');
		}
		throw fail('Whenever refused the request. Check the node parameters and account access.');
	}

	if (!objectValue(content) || !objectValue(content.result)) {
		throw fail('Whenever did not return structured data.');
	}
	return content.result;
}
