import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { callTool } from './mcp';

export async function getAccount(
	context: IExecuteFunctions,
	itemIndex: number,
): Promise<IDataObject> {
	const account = await callTool(context, 'get_current_user', {}, itemIndex);
	if (account.isLoggedIn !== true) {
		throw new NodeOperationError(
			context.getNode(),
			'Whenever did not confirm a signed-in account. Reconnect your account.',
			{ itemIndex },
		);
	}

	return {
		isLoggedIn: true,
		email: typeof account.email === 'string' ? account.email : null,
		displayName: typeof account.displayName === 'string' ? account.displayName : null,
		photoUrl: typeof account.photoUrl === 'string' ? account.photoUrl : null,
	};
}
