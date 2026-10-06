import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class WheneverOAuth2Api implements ICredentialType {
	name = 'wheneverOAuth2Api';
	displayName = 'Whenever OAuth2 API';
	documentationUrl = 'https://github.com/wix-incubator/n8n-nodes-whenever#account-connection';
	icon = 'file:../nodes/Whenever/whenever.svg' as const;
	extends = ['oAuth2Api'];
	properties: INodeProperties[] = [
		{
			displayName: 'Use Dynamic Client Registration',
			name: 'useDynamicClientRegistration',
			type: 'hidden',
			default: true,
		},
		{
			displayName: 'Server URL',
			name: 'serverUrl',
			type: 'hidden',
			default: 'https://mcp.whenever.dev/',
		},
		{
			displayName: 'Resource URL',
			name: 'resourceUrl',
			type: 'hidden',
			default: 'https://mcp.whenever.dev/',
		},
		{
			displayName: 'Scope',
			name: 'scope',
			type: 'hidden',
			default: 'whenever',
		},
		{
			displayName:
				'Whenever account authorization expires after one hour. Reconnect before using account operations after expiry.',
			name: 'expiryNotice',
			type: 'notice',
			default: '',
		},
	];
}
