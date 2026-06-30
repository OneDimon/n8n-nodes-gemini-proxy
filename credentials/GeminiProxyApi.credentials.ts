import {
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class GeminiProxyApi implements ICredentialType {
	name = 'geminiProxyApi';
	displayName = 'Gemini (Proxy-aware) API';
	documentationUrl = 'https://ai.google.dev/gemini-api/docs/api-key';
	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://generativelanguage.googleapis.com',
			description: 'Override only if you route through your own reverse proxy',
		},
		{
			displayName: 'Use Proxy',
			name: 'useProxy',
			type: 'boolean',
			default: false,
			description: 'Whether to route the request through an explicit HTTP/SOCKS5 proxy (e.g. Cloudflare WARP)',
		},
		{
			displayName: 'Proxy URL',
			name: 'proxyUrl',
			type: 'string',
			default: 'socks5://127.0.0.1:1080',
			description: 'Example: socks5://127.0.0.1:1080 or http://127.0.0.1:7890',
			displayOptions: {
				show: { useProxy: [true] },
			},
		},
	];
}
