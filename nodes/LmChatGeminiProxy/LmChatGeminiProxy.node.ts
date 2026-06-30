import {
	NodeConnectionTypes,
	type ISupplyDataFunctions,
	type INodeType,
	type INodeTypeDescription,
	type SupplyData,
} from 'n8n-workflow';
import { ChatGeminiProxy } from './ChatGeminiProxy';

export class LmChatGeminiProxy implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Gemini Chat Model (Proxy)',
		name: 'lmChatGeminiProxy',
		icon: 'file:gemini.svg',
		group: ['transform'],
		version: 1,
		description:
			'Gemini chat model that makes direct REST calls through an explicit HTTP/SOCKS5 proxy (e.g. WARP), bypassing the official Google SDK proxy bug',
		defaults: { name: 'Gemini Chat Model (Proxy)' },
		codex: {
			categories: ['AI'],
			subcategories: { AI: ['Language Models'] },
		},
		// this makes the node usable as a Chat Model input on the AI Agent node
		inputs: [],
		outputs: [NodeConnectionTypes.AiLanguageModel],
		outputNames: ['Model'],
		credentials: [
			{
				name: 'geminiProxyApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Model',
				name: 'model',
				type: 'string',
				default: 'gemini-2.5-flash',
				description: 'e.g. gemini-2.5-flash, gemini-2.5-pro',
			},
			{
				displayName: 'Temperature',
				name: 'temperature',
				type: 'number',
				default: 0.7,
				typeOptions: { minValue: 0, maxValue: 2, numberStepSize: 0.1 },
			},
			{
				displayName: 'Max Output Tokens',
				name: 'maxOutputTokens',
				type: 'number',
				default: 8192,
			},
		],
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const credentials = await this.getCredentials('geminiProxyApi');
		const model = this.getNodeParameter('model', itemIndex) as string;
		const temperature = this.getNodeParameter('temperature', itemIndex) as number;
		const maxOutputTokens = this.getNodeParameter('maxOutputTokens', itemIndex) as number;

		const chatModel = new ChatGeminiProxy({
			apiKey: credentials.apiKey as string,
			model,
			baseUrl: credentials.baseUrl as string,
			temperature,
			maxOutputTokens,
			proxyUrl: credentials.useProxy ? (credentials.proxyUrl as string) : undefined,
		});

		return { response: chatModel };
	}
}
