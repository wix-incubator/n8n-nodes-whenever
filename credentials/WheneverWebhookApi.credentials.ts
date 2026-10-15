import type { ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';

export class WheneverWebhookApi implements ICredentialType {
	name = 'wheneverWebhookApi';
	displayName = 'Whenever Webhook API';
	documentationUrl = 'https://github.com/wix-incubator/n8n-nodes-whenever#credentials';
	icon = 'file:../nodes/Whenever/whenever.svg' as const;
	test: ICredentialTestRequest = {
		request: {
			method: 'HEAD',
			url: '={{ $credentials.webhookUrl }}',
		},
	};

	properties: INodeProperties[] = [
		// eslint-disable-next-line @n8n/community-nodes/credential-unnecessary-password
		{
			displayName: 'Webhook URL',
			name: 'webhookUrl',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			placeholder: 'https://your-whenever-host/hooks/generic/your-endpoint',
			description:
				'The generic webhook URL of an active Whenever workflow. Treat this URL as a password.',
		},
	];
}
