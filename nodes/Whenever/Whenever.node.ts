import { createHash } from 'node:crypto';
import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

function workflowRequestBody(
	context: IExecuteFunctions,
	itemIndex: number,
): { body: string; contentType: string } {
	const inputFormat = context.getNodeParameter('inputFormat', itemIndex, 'json');
	switch (inputFormat) {
		case 'json': {
			const input = context.getNodeParameter('input', itemIndex) as unknown;
			try {
				const value: unknown = typeof input === 'string' ? JSON.parse(input) : input;
				const body = JSON.stringify(value);
				if (body === undefined)
					throw new NodeOperationError(context.getNode(), 'Missing JSON input', { itemIndex });
				return { body, contentType: 'application/json' };
			} catch {
				throw new NodeOperationError(context.getNode(), 'JSON Input must contain valid JSON.', {
					itemIndex,
				});
			}
		}
		case 'form': {
			const fields = context.getNodeParameter('formFields', itemIndex, {}) as {
				values?: Array<{ name: string; value: string }>;
			};
			const form = new URLSearchParams();
			for (const field of fields.values ?? []) form.append(field.name, field.value);
			return { body: form.toString(), contentType: 'application/x-www-form-urlencoded' };
		}
		case 'text':
			return {
				body: context.getNodeParameter('textInput', itemIndex) as string,
				contentType: 'text/plain',
			};
		default:
			throw new NodeOperationError(context.getNode(), 'Unsupported input format.', { itemIndex });
	}
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
		try {
			const url = new URL(webhookUrl);
			if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) {
				throw new NodeOperationError(this.getNode(), 'Invalid webhook URL');
			}
		} catch {
			throw new NodeOperationError(
				this.getNode(),
				'Webhook URL must be a valid HTTP or HTTPS URL without embedded credentials or a fragment.',
			);
		}

		const nodeContext = this.getContext('node');
		// n8n preserves this context when a saved execution is retried under a new execution ID.
		nodeContext.wheneverExecutionId ??= this.getExecutionId();
		const deliveryScope = [
			this.getInstanceId(),
			this.getWorkflow().id,
			nodeContext.wheneverExecutionId,
			this.getNode().id,
			this.getWorkflowDataProxy(0).$runIndex,
		];
		const results: INodeExecutionData[] = [];
		for (let itemIndex = 0; itemIndex < this.getInputData().length; itemIndex++) {
			try {
				const { body, contentType } = workflowRequestBody(this, itemIndex);

				let response: { statusCode: number; body: unknown };
				try {
					response = await this.helpers.httpRequestWithAuthentication.call(
						this,
						'wheneverWebhookApi',
						{
							method: 'POST',
							url: webhookUrl,
							headers: {
								'Content-Type': contentType,
								Accept: 'application/json',
								'Idempotency-Key': createHash('sha256')
									.update(JSON.stringify([...deliveryScope, itemIndex]))
									.digest('hex'),
							},
							body,
							json: false,
							encoding: 'text',
							returnFullResponse: true,
							ignoreHttpStatusErrors: true,
							disableFollowRedirect: true,
							timeout: 30000,
						},
					);
				} catch {
					throw new NodeOperationError(this.getNode(), 'Whenever could not confirm acceptance.', {
						itemIndex,
						description: 'Check Whenever before retrying. A run may have started.',
					});
				}

				if (response.statusCode < 200 || response.statusCode >= 300) {
					throw new NodeApiError(
						this.getNode(),
						{},
						{
							itemIndex,
							httpCode: String(response.statusCode),
							message: `Whenever rejected the request (HTTP ${response.statusCode}).`,
							description:
								'Check the webhook URL and input in Whenever. A run start was not confirmed.',
						},
					);
				}

				let receipt: unknown;
				try {
					receipt = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
				} catch {
					receipt = undefined;
				}
				if (
					receipt === null ||
					typeof receipt !== 'object' ||
					!('runId' in receipt) ||
					typeof receipt.runId !== 'string' ||
					receipt.runId.trim().length === 0
				) {
					throw new NodeOperationError(this.getNode(), 'Whenever did not return a valid runId.', {
						itemIndex,
						description:
							'A run start was not confirmed. Check that the Whenever workflow is active before retrying.',
					});
				}
				results.push({ json: { runId: receipt.runId }, pairedItem: { item: itemIndex } });
			} catch (error) {
				const nodeError =
					error instanceof NodeApiError || error instanceof NodeOperationError
						? error
						: new NodeOperationError(this.getNode(), 'Unable to start the Whenever run.', {
								itemIndex,
							});
				if (!this.continueOnFail()) throw nodeError;
				results.push({ json: { error: nodeError.message }, pairedItem: { item: itemIndex } });
			}
		}
		return [results];
	}
}
