import { createHash } from 'node:crypto';
import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { getAccount } from './account';
import { getRun } from './runs';
import { getWebhooks, getWorkflows, isWebhookUrl, webhookSelector } from './workflows';

type WebhookRequest = { body: string; contentType: string };
type WebhookResponse = { statusCode: number; body: unknown };

function textValue(
	context: IExecuteFunctions,
	itemIndex: number,
	value: unknown,
	label: string,
): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	throw new NodeOperationError(context.getNode(), `${label} must be text.`, { itemIndex });
}

function jsonRequest(context: IExecuteFunctions, itemIndex: number): WebhookRequest {
	const input = context.getNodeParameter('input', itemIndex) as unknown;
	let value: unknown = input;
	if (typeof input === 'string') {
		try {
			value = JSON.parse(input);
		} catch {
			value = undefined;
		}
	}
	const body = JSON.stringify(value) as string | undefined;
	if (body === undefined) {
		throw new NodeOperationError(context.getNode(), 'JSON Input must contain valid JSON.', {
			itemIndex,
		});
	}
	return { body, contentType: 'application/json' };
}

function formRequest(context: IExecuteFunctions, itemIndex: number): WebhookRequest {
	const fields = context.getNodeParameter('formFields', itemIndex, {}) as {
		values?: Array<{ name: unknown; value: unknown }>;
	};
	const form = new URLSearchParams();
	for (const field of fields.values ?? []) {
		form.append(
			textValue(context, itemIndex, field.name, 'Form field name'),
			textValue(context, itemIndex, field.value, 'Form field value'),
		);
	}
	return { body: form.toString(), contentType: 'application/x-www-form-urlencoded' };
}

function textRequest(context: IExecuteFunctions, itemIndex: number): WebhookRequest {
	const text = context.getNodeParameter('textInput', itemIndex) as unknown;
	return { body: textValue(context, itemIndex, text, 'Text Input'), contentType: 'text/plain' };
}

function webhookRequest(context: IExecuteFunctions, itemIndex: number): WebhookRequest {
	switch (context.getNodeParameter('inputFormat', itemIndex)) {
		case 'json':
			return jsonRequest(context, itemIndex);
		case 'form':
			return formRequest(context, itemIndex);
		case 'text':
			return textRequest(context, itemIndex);
		default:
			throw new NodeOperationError(context.getNode(), 'Unsupported input format.', { itemIndex });
	}
}

function transportErrorCode(error: unknown): string | undefined {
	const cause = (error as { cause?: unknown } | null)?.cause;
	for (const candidate of [error, cause]) {
		const code = (candidate as { code?: unknown } | null)?.code;
		if (typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code)) return code;
	}
	return undefined;
}

async function deliver(
	context: IExecuteFunctions,
	itemIndex: number,
	webhookUrl: string,
	request: WebhookRequest,
	idempotencyKey: string,
): Promise<WebhookResponse> {
	try {
		return await context.helpers.httpRequest({
			method: 'POST',
			url: webhookUrl,
			headers: {
				'Content-Type': request.contentType,
				Accept: 'application/json',
				'Idempotency-Key': idempotencyKey,
			},
			body: request.body,
			json: false,
			encoding: 'text',
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			disableFollowRedirect: true,
			timeout: 30000,
		});
	} catch (error) {
		const code = transportErrorCode(error);
		throw new NodeOperationError(context.getNode(), 'Whenever could not confirm acceptance.', {
			itemIndex,
			description: `Check Whenever before retrying. A run may have started.${code === undefined ? '' : ` (${code})`}`,
		});
	}
}

function rejection(
	context: IExecuteFunctions,
	itemIndex: number,
	statusCode: number,
): NodeApiError {
	const retryable = statusCode === 429 || statusCode >= 500;
	return new NodeApiError(
		context.getNode(),
		{},
		{
			itemIndex,
			httpCode: String(statusCode),
			message: retryable
				? `Whenever could not process the request (HTTP ${statusCode}).`
				: `Whenever rejected the request (HTTP ${statusCode}).`,
			description: retryable
				? 'Retry later. A run start was not confirmed, and a retry reuses the same delivery key.'
				: 'Check the webhook URL and input in Whenever. A run start was not confirmed.',
		},
	);
}

function acceptedRunId(body: unknown): string | undefined {
	let receipt: unknown;
	try {
		receipt = typeof body === 'string' ? JSON.parse(body) : body;
	} catch {
		return undefined;
	}
	if (receipt === null || typeof receipt !== 'object' || !('runId' in receipt)) return undefined;
	const { runId } = receipt;
	return typeof runId === 'string' && runId.trim().length > 0 ? runId : undefined;
}

type ItemOperation = (itemIndex: number) => Promise<IDataObject>;

async function startWorkflow(
	context: IExecuteFunctions,
	accountConnection: boolean,
): Promise<ItemOperation> {
	let webhookUrl = '';
	if (!accountConnection) {
		const credentials = await context.getCredentials('wheneverWebhookApi');
		webhookUrl = String(credentials.webhookUrl ?? '').trim();
		if (!isWebhookUrl(webhookUrl)) {
			throw new NodeOperationError(
				context.getNode(),
				'Webhook URL must be a valid HTTP or HTTPS URL without embedded credentials or a fragment.',
			);
		}
	}

	const nodeContext = context.getContext('node');
	nodeContext.wheneverExecutionId ??= context.getExecutionId();
	const deliveryScope = [
		context.getInstanceId(),
		context.getWorkflow().id,
		nodeContext.wheneverExecutionId,
		context.getNode().id,
		context.getWorkflowDataProxy(0).$runIndex,
	];
	const deliveryKey = (itemIndex: number): string =>
		createHash('sha256')
			.update(JSON.stringify([...deliveryScope, itemIndex]))
			.digest('hex');

	const selectedWebhook = webhookSelector(context);
	return async (itemIndex) => {
		const request = webhookRequest(context, itemIndex);
		const response = await deliver(
			context,
			itemIndex,
			accountConnection ? await selectedWebhook(itemIndex) : webhookUrl,
			request,
			deliveryKey(itemIndex),
		);
		if (response.statusCode < 200 || response.statusCode >= 300) {
			throw rejection(context, itemIndex, response.statusCode);
		}

		const runId = acceptedRunId(response.body);
		if (runId === undefined) {
			throw new NodeOperationError(context.getNode(), 'Whenever did not return a valid runId.', {
				itemIndex,
				description:
					'A run start was not confirmed. Check that the Whenever workflow is active before retrying.',
			});
		}
		return { runId };
	};
}

async function itemOperation(
	context: IExecuteFunctions,
	operation: unknown,
	accountConnection: boolean,
): Promise<ItemOperation> {
	if (accountConnection && operation === 'getAccount') {
		return async (itemIndex) => await getAccount(context, itemIndex);
	}
	if (accountConnection && operation === 'getRun') {
		return async (itemIndex) => await getRun(context, itemIndex);
	}
	if (operation === 'start') return await startWorkflow(context, accountConnection);
	throw new NodeOperationError(
		context.getNode(),
		'A webhook connection supports only Start Workflow.',
	);
}

export class Whenever implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Whenever',
		name: 'whenever',
		icon: { light: 'file:whenever.svg', dark: 'file:whenever.svg' },
		group: ['output'],
		version: 1,
		subtitle:
			'={{({getAccount: "Get Account", getRun: "Get Run", start: "Start Workflow"})[$parameter["operation"]]}}',
		description: 'Start Whenever workflows and read their run results',
		defaults: { name: 'Whenever' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'wheneverWebhookApi',
				required: true,
				displayOptions: { show: { authentication: ['webhook'] } },
			},
			{
				name: 'wheneverOAuth2Api',
				required: true,
				displayOptions: { show: { authentication: ['account'] } },
			},
		],
		properties: [
			{
				displayName: 'Connection',
				name: 'authentication',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Webhook URL', value: 'webhook' },
					{ name: 'Whenever Account', value: 'account' },
				],
				default: 'webhook',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Get Run',
						value: 'getRun',
						action: 'Get a run',
						description: 'Read run status and output from a bounded event page',
						displayOptions: { show: { authentication: ['account'] } },
					},
					{
						name: 'Get Account',
						value: 'getAccount',
						action: 'Get the connected account',
						description: 'Check account access without starting a workflow',
						displayOptions: { show: { authentication: ['account'] } },
					},
					{
						name: 'Start Workflow',
						value: 'start',
						action: 'Start a workflow',
						description: 'Send input to a Whenever webhook and return the accepted run ID',
					},
				],
				default: 'start',
			},
			{
				displayName: 'Run ID',
				name: 'runId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { authentication: ['account'], operation: ['getRun'] } },
				description: 'Run ID returned by Start Workflow',
			},
			{
				displayName: 'After Sequence',
				name: 'afterSeq',
				type: 'number',
				default: 0,
				typeOptions: { minValue: 0, numberPrecision: 0 },
				displayOptions: { show: { authentication: ['account'], operation: ['getRun'] } },
				description:
					'Read events after this sequence. Use nextSeq from the preceding page to continue.',
			},
			{
				displayName: 'Event Limit',
				name: 'eventLimit',
				type: 'number',
				default: 100,
				typeOptions: { minValue: 1, maxValue: 100, numberPrecision: 0 },
				displayOptions: { show: { authentication: ['account'], operation: ['getRun'] } },
				description: 'Maximum number of stored events to read in this request',
			},
			{
				displayName: 'Workflow',
				name: 'workflowId',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				displayOptions: { show: { authentication: ['account'], operation: ['start'] } },
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						typeOptions: { searchListMethod: 'getWorkflows', searchable: true },
					},
					{ displayName: 'By ID', name: 'id', type: 'string' },
				],
				description: 'Workflow to start. If the account list is incomplete, enter the workflow ID.',
			},
			{
				displayName: 'Webhook Name or ID',
				name: 'webhookId',
				type: 'options',
				default: '',
				required: true,
				typeOptions: { loadOptionsMethod: 'getWebhooks', loadOptionsDependsOn: ['workflowId.value'] },
				displayOptions: { show: { authentication: ['account'], operation: ['start'] } },
				description:
					'Enabled generic webhook to call. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName:
					'This node confirms that Whenever accepted the run. It does not wait for completion or confirm workflow success.',
				name: 'acceptanceNotice',
				displayOptions: { show: { operation: ['start'] } },
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Input Format',
				name: 'inputFormat',
				displayOptions: { show: { operation: ['start'] } },
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Form Values',
						value: 'form',
						description: 'Named values sent as strings',
					},
					{
						name: 'JSON',
						value: 'json',
						description: 'Structured data, including objects and arrays',
					},
					{
						name: 'Text',
						value: 'text',
						description: 'Plain text, CSV, XML, or other text sent unchanged',
					},
				],
				default: 'json',
			},
			{
				displayName: 'JSON Input',
				name: 'input',
				type: 'json',
				required: true,
				default: '{}',
				displayOptions: { show: { operation: ['start'], inputFormat: ['json'] } },
				description:
					'JSON sent to Whenever as the workflow input. Expressions can supply an object.',
			},
			{
				displayName: 'Form Fields',
				name: 'formFields',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				placeholder: 'Add Field',
				displayOptions: { show: { operation: ['start'], inputFormat: ['form'] } },
				description: 'Named values sent to Whenever. All values arrive as strings.',
				options: [
					{
						displayName: 'Fields',
						name: 'values',
						values: [
							{
								displayName: 'Name',
								name: 'name',
								type: 'string',
								required: true,
								default: '',
								description: 'The name of the form field',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
								description: 'The value of the form field',
							},
						],
					},
				],
			},
			{
				displayName: 'Text Input',
				name: 'textInput',
				type: 'string',
				typeOptions: { rows: 5 },
				required: true,
				default: '',
				displayOptions: { show: { operation: ['start'], inputFormat: ['text'] } },
				description:
					'Text sent unchanged to Whenever. The workflow must interpret CSV or XML itself.',
			},
		],
	};

	methods = { listSearch: { getWorkflows }, loadOptions: { getWebhooks } };

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const operation = await itemOperation(
			this,
			this.getNodeParameter('operation', 0, 'start'),
			this.getNodeParameter('authentication', 0, 'webhook') === 'account',
		);

		const results: INodeExecutionData[] = [];
		for (let itemIndex = 0; itemIndex < this.getInputData().length; itemIndex++) {
			try {
				results.push({ json: await operation(itemIndex), pairedItem: { item: itemIndex } });
			} catch (error) {
				const nodeError =
					error instanceof NodeApiError
						? error
						: new NodeOperationError(this.getNode(), error as Error, { itemIndex });
				if (!this.continueOnFail()) throw nodeError;
				results.push({ json: { error: nodeError.message }, pairedItem: { item: itemIndex } });
			}
		}
		return [results];
	}
}
