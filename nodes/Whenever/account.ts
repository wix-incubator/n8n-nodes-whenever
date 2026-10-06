import type { IDataObject, IExecuteFunctions, ILoadOptionsFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

export const MCP_URL = 'https://mcp.whenever.dev/';
type AccountContext = IExecuteFunctions | ILoadOptionsFunctions;

export function objectValue(value: unknown): value is IDataObject {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function callTool(
	context: AccountContext,
	name: string,
	args: IDataObject = {},
): Promise<IDataObject> {
	let response: { statusCode: number; body: unknown };
	try {
		response = await context.helpers.httpRequestWithAuthentication.call(
			context,
			'wheneverOAuth2Api',
			{
				method: 'POST',
				url: MCP_URL,
				headers: {
					Accept: 'application/json, text/event-stream',
					'MCP-Protocol-Version': '2025-03-26',
				},
				body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
				json: true,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
				disableFollowRedirect: true,
				timeout: 30000,
			},
		);
	} catch {
		throw new NodeOperationError(
			context.getNode(),
			'Whenever could not read the account. Reconnect the account if its authorization expired.',
		);
	}
	if (response.statusCode === 401) {
		throw new NodeOperationError(
			context.getNode(),
			'Reconnect your Whenever account. Its authorization is missing or expired.',
		);
	}
	if (response.statusCode < 200 || response.statusCode >= 300) {
		throw new NodeOperationError(
			context.getNode(),
			`Whenever rejected the account request (HTTP ${response.statusCode}).`,
		);
	}
	const body = response.body;
	if (
		!objectValue(body) ||
		body.jsonrpc !== '2.0' ||
		body.id !== 1 ||
		body.error !== undefined ||
		!objectValue(body.result)
	) {
		throw new NodeOperationError(context.getNode(), 'Whenever returned an invalid MCP response.');
	}
	if (body.result.isError === true) {
		throw new NodeOperationError(
			context.getNode(),
			'Whenever refused the account operation. Check access and reconnect your account if needed.',
		);
	}
	const content = body.result.structuredContent;
	if (!objectValue(content) || !objectValue(content.result)) {
		throw new NodeOperationError(
			context.getNode(),
			'Whenever did not return structured account data.',
		);
	}
	return content.result;
}

export async function getAccount(context: AccountContext): Promise<IDataObject> {
	const account = await callTool(context, 'get_current_user');
	if (account.isLoggedIn !== true) {
		throw new NodeOperationError(
			context.getNode(),
			'Whenever did not confirm a signed-in account. Reconnect your account.',
		);
	}
	return {
		isLoggedIn: true,
		email: typeof account.email === 'string' ? account.email : null,
		displayName: typeof account.displayName === 'string' ? account.displayName : null,
		photoUrl: typeof account.photoUrl === 'string' ? account.photoUrl : null,
	};
}
