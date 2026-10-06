import { createHash } from 'node:crypto';
import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

type WebhookRequest = { body: string; contentType: string };
type WebhookResponse = { statusCode: number; body: unknown };

function isWebhookUrl(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.hash;
}

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
		return (await context.helpers.httpRequestWithAuthentication.call(
			context,
			'wheneverWebhookApi',
			{
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
			},
		)) as WebhookResponse;
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

export class Whenever implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Whenever',
		name: 'whenever',
		icon: { light: 'file:whenever.svg', dark: 'file:whenever.svg' },
		group: ['output'],
		version: 1,
		subtitle: 'Start Workflow',
		description: 'Start a Whenever workflow run and return its run ID',
		defaults: { name: 'Whenever' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [{ name: 'wheneverWebhookApi', required: true }],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
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
				displayName:
					'This node confirms that Whenever accepted the run. It does not wait for completion or confirm workflow success.',
				name: 'acceptanceNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Input Format',
				name: 'inputFormat',
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
				displayOptions: { show: { inputFormat: ['json'] } },
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
				displayOptions: { show: { inputFormat: ['form'] } },
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
				displayOptions: { show: { inputFormat: ['text'] } },
				description:
					'Text sent unchanged to Whenever. The workflow must interpret CSV or XML itself.',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const credentials = await this.getCredentials('wheneverWebhookApi');
		const webhookUrl = String(credentials.webhookUrl ?? '').trim();
		if (!isWebhookUrl(webhookUrl)) {
			throw new NodeOperationError(
				this.getNode(),
				'Webhook URL must be a valid HTTP or HTTPS URL without embedded credentials or a fragment.',
			);
		}

		const nodeContext = this.getContext('node');
		nodeContext.wheneverExecutionId ??= this.getExecutionId();
		const deliveryScope = [
			this.getInstanceId(),
			this.getWorkflow().id,
			nodeContext.wheneverExecutionId,
			this.getNode().id,
			this.getWorkflowDataProxy(0).$runIndex,
		];
		const deliveryKey = (itemIndex: number): string =>
			createHash('sha256')
				.update(JSON.stringify([...deliveryScope, itemIndex]))
				.digest('hex');

		const results: INodeExecutionData[] = [];
		for (let itemIndex = 0; itemIndex < this.getInputData().length; itemIndex++) {
			try {
				const request = webhookRequest(this, itemIndex);
				const response = await deliver(
					this,
					itemIndex,
					webhookUrl,
					request,
					deliveryKey(itemIndex),
				);
				if (response.statusCode < 200 || response.statusCode >= 300) {
					throw rejection(this, itemIndex, response.statusCode);
				}
				const runId = acceptedRunId(response.body);
				if (runId === undefined) {
					throw new NodeOperationError(this.getNode(), 'Whenever did not return a valid runId.', {
						itemIndex,
						description:
							'A run start was not confirmed. Check that the Whenever workflow is active before retrying.',
					});
				}
				results.push({ json: { runId }, pairedItem: { item: itemIndex } });
			} catch (error) {
				const nodeError =
					error instanceof NodeApiError || error instanceof NodeOperationError
						? error
						: new NodeOperationError(this.getNode(), error as Error, { itemIndex });
				if (!this.continueOnFail()) throw nodeError;
				results.push({ json: { error: nodeError.message }, pairedItem: { item: itemIndex } });
			}
		}
		return [results];
	}
}
