import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeListSearchResult,
	INodePropertyOptions,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { arrayOf, callTool, objectValue } from './mcp';

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

type Workflow = { id: string; name: string };
type Endpoint = IDataObject & { endpointId: string; integration: string; enabled: boolean };

function isWorkflow(value: unknown): value is Workflow {
	return objectValue(value) && typeof value.id === 'string' && typeof value.name === 'string';
}

function isEndpoint(value: unknown): value is Endpoint {
	return (
		objectValue(value) &&
		typeof value.endpointId === 'string' &&
		typeof value.integration === 'string' &&
		typeof value.enabled === 'boolean'
	);
}

export async function getWorkflows(
	this: ILoadOptionsFunctions,
	filter = '',
): Promise<INodeListSearchResult> {
	const workflows = arrayOf((await callTool(this, 'list_workflows')).workflows, isWorkflow);
	if (!workflows) {
		throw new NodeOperationError(this.getNode(), 'Whenever returned an invalid workflow list.');
	}

	const search = filter.toLowerCase();
	const matches = workflows.filter(
		({ id, name }) => name.toLowerCase().includes(search) || id.toLowerCase().includes(search),
	);
	return { results: matches.map(({ id, name }) => ({ name, value: id })) };
}

async function workflowWebhooks(
	context: WorkflowContext,
	workflowId: unknown,
	itemIndex = 0,
): Promise<Endpoint[]> {
	if (typeof workflowId !== 'string' || workflowId.trim() === '') {
		throw new NodeOperationError(context.getNode(), 'Select a workflow or enter its ID.', {
			itemIndex,
		});
	}

	const data = await callTool(context, 'list_webhooks', { workflow_id: workflowId }, itemIndex);
	const endpoints = arrayOf(data.endpoints, isEndpoint);
	if (!endpoints) {
		throw new NodeOperationError(context.getNode(), 'Whenever returned an invalid webhook list.', {
			itemIndex,
		});
	}
	return endpoints.filter(({ integration, enabled }) => integration === 'generic' && enabled);
}

export async function getWebhooks(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const workflowId = this.getNodeParameter('workflowId', '', { extractValue: true });
	const endpoints = await workflowWebhooks(this, workflowId);
	return endpoints.map(({ endpointId, name }) => ({
		name: typeof name === 'string' && name ? name : endpointId,
		value: endpointId,
	}));
}

export function webhookSelector(
	context: IExecuteFunctions,
): (itemIndex: number) => Promise<string> {
	const webhooks = new Map<unknown, Endpoint[]>();

	return async (itemIndex) => {
		const endpointId = context.getNodeParameter('webhookId', itemIndex);
		const workflowId = context.getNodeParameter('workflowId', itemIndex, '', {
			extractValue: true,
		});
		const endpoints =
			webhooks.get(workflowId) ?? (await workflowWebhooks(context, workflowId, itemIndex));
		webhooks.set(workflowId, endpoints);

		const endpoint = endpoints.find((candidate) => candidate.endpointId === endpointId);
		if (!endpoint || typeof endpoint.url !== 'string' || !isWebhookUrl(endpoint.url)) {
			throw new NodeOperationError(
				context.getNode(),
				'The selected webhook is unavailable. Select an enabled generic webhook on this workflow.',
				{ itemIndex },
			);
		}
		return endpoint.url;
	};
}
