import axios, { AxiosInstance } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
	BaseChatModel,
	type BaseChatModelParams,
	type BindToolsInput,
} from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage, ToolMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { Runnable } from '@langchain/core/runnables';
import type { StructuredToolInterface } from '@langchain/core/tools';

export interface GeminiProxyChatParams extends BaseChatModelParams {
	apiKey: string;
	model: string;
	baseUrl: string;
	temperature?: number;
	maxOutputTokens?: number;
	proxyUrl?: string;
}

interface GeminiFunctionDeclaration {
	name: string;
	description?: string;
	parameters?: Record<string, unknown>;
}

function buildAgent(proxyUrl?: string) {
	if (!proxyUrl) return undefined;
	if (proxyUrl.startsWith('socks')) return new SocksProxyAgent(proxyUrl);
	return new HttpsProxyAgent(proxyUrl);
}

function toGeminiRole(msg: BaseMessage): 'user' | 'model' | 'function' {
	const type = msg._getType();
	if (type === 'ai') return 'model';
	if (type === 'tool') return 'function';
	return 'user'; // human + system folded into user turn for simplicity
}

// Converts a LangChain StructuredTool (zod schema) into Gemini's functionDeclaration format.
function toolToFunctionDeclaration(tool: StructuredToolInterface): GeminiFunctionDeclaration {
	let parameters: Record<string, unknown> | undefined;
	try {
		const schema = tool.schema as unknown;
		if (schema && typeof (schema as { parse?: unknown }).parse === 'function') {
			const json = zodToJsonSchema(schema as Parameters<typeof zodToJsonSchema>[0], {
				target: 'openApi3',
			}) as Record<string, unknown>;
			delete json.$schema;
			delete (json as Record<string, unknown>).additionalProperties;
			parameters = json;
		}
	} catch {
		parameters = undefined;
	}
	return {
		name: tool.name,
		description: tool.description,
		parameters,
	};
}

export class ChatGeminiProxy extends BaseChatModel {
	apiKey: string;
	model: string;
	baseUrl: string;
	temperature: number;
	maxOutputTokens: number;
	client: AxiosInstance;
	boundTools?: GeminiFunctionDeclaration[];

	constructor(params: GeminiProxyChatParams) {
		super(params);
		this.apiKey = params.apiKey;
		this.model = params.model;
		this.baseUrl = params.baseUrl.replace(/\/$/, '');
		this.temperature = params.temperature ?? 0.7;
		this.maxOutputTokens = params.maxOutputTokens ?? 8192;

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

	// Called by AI Agent / Tools Agent: model.bindTools(tools) must exist and
	// return a Runnable for the model to be accepted as "supports tool calling".
	bindTools(tools: BindToolsInput[]): Runnable {
		const declarations = (tools as StructuredToolInterface[]).map(toolToFunctionDeclaration);
		const bound = new ChatGeminiProxy({
			apiKey: this.apiKey,
			model: this.model,
			baseUrl: this.baseUrl,
			temperature: this.temperature,
			maxOutputTokens: this.maxOutputTokens,
		});
		bound.client = this.client;
		bound.boundTools = declarations;
		return bound as unknown as Runnable;
	}

	async _generate(messages: BaseMessage[]): Promise<ChatResult> {
		const contents: Array<Record<string, unknown>> = [];

		for (const m of messages) {
			const type = m._getType();
			if (type === 'system') continue;

			if (type === 'tool') {
				const tm = m as ToolMessage;
				contents.push({
					role: 'function',
					parts: [
						{
							functionResponse: {
								name: tm.name ?? tm.tool_call_id,
								response: { content: tm.content },
							},
						},
					],
				});
				continue;
			}

			if (type === 'ai') {
				const aiMsg = m as AIMessage;
				if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
					contents.push({
						role: 'model',
						parts: aiMsg.tool_calls.map((tc) => ({
							functionCall: { name: tc.name, args: tc.args },
						})),
					});
					continue;
				}
			}

			contents.push({
				role: toGeminiRole(m),
				parts: [{ text: m.content.toString() }],
			});
		}

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
		if (this.boundTools && this.boundTools.length > 0) {
			body.tools = [{ functionDeclarations: this.boundTools }];
		}

		const { data } = await this.client.post(url, body, {
			headers: { 'Content-Type': 'application/json' },
		});

		const parts: Array<Record<string, unknown>> = data?.candidates?.[0]?.content?.parts ?? [];
		const textParts = parts
			.filter((p): p is { text: string } => typeof p.text === 'string')
			.map((p) => p.text);
		const functionCallParts = parts.filter(
			(p): p is { functionCall: { name: string; args?: Record<string, unknown> } } =>
				Boolean(p.functionCall),
		);

		const text = textParts.join('');

		if (functionCallParts.length > 0) {
			const toolCalls = functionCallParts.map((p, i) => ({
				name: p.functionCall.name,
				args: p.functionCall.args ?? {},
				id: `${p.functionCall.name}_${Date.now()}_${i}`,
				type: 'tool_call' as const,
			}));

			const aiMessage = new AIMessage({
				content: text,
				tool_calls: toolCalls,
			});

			return { generations: [{ text, message: aiMessage }] };
		}

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
