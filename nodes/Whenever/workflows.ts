import type {
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeListSearchResult,
	INodePropertyOptions,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { callTool, objectValue } from './account';

type WorkflowContext = IExecuteFunctions | ILoadOptionsFunctions;

export function isWebhookUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.hash
		);
	} catch {
		return false;
	}
}

export async function getWorkflows(
	this: ILoadOptionsFunctions,
	filter = '',
): Promise<INodeListSearchResult> {
	const data = await callTool(this, 'list_workflows');
	if (
		!Array.isArray(data.workflows) ||
		data.workflows.some(
			(workflow) =>
				!objectValue(workflow) ||
				typeof workflow.id !== 'string' ||
				typeof workflow.name !== 'string',
		)
	) {
		throw new NodeOperationError(this.getNode(), 'Whenever returned an invalid workflow list.');
	}
	const search = filter.toLowerCase();
	return {
		results: data.workflows
			.filter(objectValue)
			.filter(
				(workflow) =>
					String(workflow.name).toLowerCase().includes(search) ||
					String(workflow.id).toLowerCase().includes(search),
			)
			.map((workflow) => ({ name: String(workflow.name), value: String(workflow.id) })),
	};
}

async function workflowWebhooks(context: WorkflowContext, itemIndex: number) {
	const workflowId = context.getNodeParameter('workflowId', itemIndex, '', { extractValue: true });
	if (typeof workflowId !== 'string' || workflowId.trim() === '') {
		throw new NodeOperationError(context.getNode(), 'Select a workflow or enter its ID.', {
			itemIndex,
		});
	}
	const data = await callTool(context, 'list_webhooks', { workflow_id: workflowId });
	if (
		!Array.isArray(data.endpoints) ||
		data.endpoints.some(
			(endpoint) =>
				!objectValue(endpoint) ||
				typeof endpoint.endpointId !== 'string' ||
				typeof endpoint.integration !== 'string' ||
				typeof endpoint.enabled !== 'boolean',
		)
	) {
		throw new NodeOperationError(context.getNode(), 'Whenever returned an invalid webhook list.', {
			itemIndex,
		});
	}
	return data.endpoints
		.filter(objectValue)
		.filter((endpoint) => endpoint.integration === 'generic' && endpoint.enabled === true);
}

export async function getWebhooks(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	return (await workflowWebhooks(this, 0)).map((endpoint) => ({
		name:
			typeof endpoint.name === 'string' && endpoint.name !== ''
				? endpoint.name
				: String(endpoint.endpointId),
		value: String(endpoint.endpointId),
	}));
}

export async function selectedWebhook(
	context: IExecuteFunctions,
	itemIndex: number,
): Promise<string> {
	const endpointId = context.getNodeParameter('webhookId', itemIndex);
	const endpoint = (await workflowWebhooks(context, itemIndex)).find(
		(candidate) => candidate.endpointId === endpointId,
	);
	if (!endpoint || typeof endpoint.url !== 'string' || !isWebhookUrl(endpoint.url)) {
		throw new NodeOperationError(
			context.getNode(),
			'The selected webhook is unavailable. Select an enabled generic webhook on this workflow.',
			{ itemIndex },
		);
	}
	return endpoint.url;
}
