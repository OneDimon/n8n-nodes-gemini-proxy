import axios, { AxiosInstance } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import {
	BaseChatModel,
	type BaseChatModelParams,
} from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { ChatResult } from '@langchain/core/outputs';

export interface GeminiProxyChatParams extends BaseChatModelParams {
	apiKey: string;
	model: string;
	baseUrl: string;
	temperature?: number;
	maxOutputTokens?: number;
	proxyUrl?: string;
}

function buildAgent(proxyUrl?: string) {
	if (!proxyUrl) return undefined;
	if (proxyUrl.startsWith('socks')) return new SocksProxyAgent(proxyUrl);
	return new HttpsProxyAgent(proxyUrl);
}

function toGeminiRole(msg: BaseMessage): 'user' | 'model' {
	const type = msg._getType();
	if (type === 'ai') return 'model';
	return 'user'; // human + system folded into user turn for simplicity
}

export class ChatGeminiProxy extends BaseChatModel {
	apiKey: string;
	model: string;
	baseUrl: string;
	temperature: number;
	maxOutputTokens: number;
	client: AxiosInstance;

	constructor(params: GeminiProxyChatParams) {
		super(params);
		this.apiKey = params.apiKey;
		this.model = params.model;
		this.baseUrl = params.baseUrl.replace(/\/$/, '');
		this.temperature = params.temperature ?? 0.7;
		this.maxOutputTokens = params.maxOutputTokens ?? 2048;

		const agent = buildAgent(params.proxyUrl);
		this.client = axios.create({
			timeout: 120_000,
			httpAgent: agent,
			httpsAgent: agent,
			proxy: false, // disable axios' own env-based proxy detection, we set the agent explicitly
		});
	}

	_llmType() {
		return 'gemini-proxy';
	}

	async _generate(messages: BaseMessage[]): Promise<ChatResult> {
		const contents = messages
			.filter((m) => m._getType() !== 'system')
			.map((m) => ({
				role: toGeminiRole(m),
				parts: [{ text: m.content.toString() }],
			}));

		const systemMsg = messages.find((m) => m._getType() === 'system');

		const url = `${this.baseUrl}/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

		const body: Record<string, unknown> = {
			contents,
			generationConfig: {
				temperature: this.temperature,
				maxOutputTokens: this.maxOutputTokens,
			},
		};
		if (systemMsg) {
			body.systemInstruction = { parts: [{ text: systemMsg.content.toString() }] };
		}

		const { data } = await this.client.post(url, body, {
			headers: { 'Content-Type': 'application/json' },
		});

		const text =
			data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ??
			'';

		return {
			generations: [
				{
					text,
					message: new AIMessage(text),
				},
			],
		};
	}
}
