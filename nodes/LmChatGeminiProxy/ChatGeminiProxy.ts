import axios, { AxiosInstance } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { zodToJsonSchema } from 'zod-to-json-schema';
import * as net from 'net';
import * as fs from 'fs';
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

// Quick TCP-reachability check, short timeout — only used to pick between candidate hosts.
function canConnect(host: string, port: number, timeoutMs = 400): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.createConnection({ host, port, timeout: timeoutMs });
		const done = (ok: boolean) => {
			socket.destroy();
			resolve(ok);
		};
		socket.once('connect', () => done(true));
		socket.once('timeout', () => done(false));
		socket.once('error', () => done(false));
	});
}

// Reads the default gateway IP from /proc/net/route (Linux containers) —
// this is normally the Docker bridge gateway, i.e. the host's address from inside the container.
function readDockerGatewayIp(): string | undefined {
	try {
		const raw = fs.readFileSync('/proc/net/route', 'utf8');
		const lines = raw.trim().split('\n').slice(1);
		for (const line of lines) {
			const cols = line.trim().split(/\s+/);
			// Destination 00000000 = default route; Gateway is hex, little-endian
			if (cols[1] === '00000000' && cols[2] && cols[2] !== '00000000') {
				const hex = cols[2];
				const bytes = [hex.slice(6, 8), hex.slice(4, 6), hex.slice(2, 4), hex.slice(0, 2)];
				return bytes.map((b) => parseInt(b, 16)).join('.');
			}
		}
	} catch {
		// not on Linux / no /proc/net/route — ignore
	}
	return undefined;
}

// Given a proxy URL whose host might not be reachable from inside a Docker container
// (e.g. "127.0.0.1" pointing at the host, not the container itself), tries a list of
// likely-correct alternatives and returns the URL rewritten to the first one that's
// actually reachable. Falls back to the original URL untouched if nothing else works
// (so the original error message stays meaningful).
async function resolveReachableProxyUrl(proxyUrl: string): Promise<string> {
	const parsed = new URL(proxyUrl.replace(/^socks5?:\/\//, 'http://'));
	const port = Number(parsed.port) || 1080;
	const isLocalhost = ['127.0.0.1', 'localhost', '0.0.0.0', '::1'].includes(parsed.hostname);

	if (!isLocalhost) {
		return proxyUrl; // user pointed at something explicit (a named container, real IP, etc.) — trust it
	}

	const candidates = [
		parsed.hostname, // try as-is first, in case we're not actually in Docker
		'host.docker.internal',
		readDockerGatewayIp(),
		'172.17.0.1',
	].filter((h): h is string => Boolean(h));

	for (const host of candidates) {
		if (await canConnect(host, port)) {
			const scheme = proxyUrl.startsWith('socks') ? proxyUrl.split('://')[0] : 'http';
			return `${scheme}://${host}:${port}`;
		}
	}

	return proxyUrl; // nothing reachable — surface the original (clearer) connection error
}

function buildAgent(proxyUrl: string) {
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
	rawProxyUrl?: string;
	client?: AxiosInstance;
	boundTools?: GeminiFunctionDeclaration[];
	private clientReady?: Promise<AxiosInstance>;

	constructor(params: GeminiProxyChatParams) {
		super(params);
		this.apiKey = params.apiKey;
		this.model = params.model;
		this.baseUrl = params.baseUrl.replace(/\/$/, '');
		this.temperature = params.temperature ?? 0.7;
		this.maxOutputTokens = params.maxOutputTokens ?? 8192;
		this.rawProxyUrl = params.proxyUrl;
	}

	_llmType() {
		return 'gemini-proxy';
	}

	// Lazily builds (and caches) an axios client. If a proxy is configured and points
	// at localhost, we first auto-probe a few Docker-friendly alternatives so the
	// node works out of the box whether the proxy runs on the host, in another
	// container, or wasn't reachable at the literal address the user typed in.
	private async getClient(): Promise<AxiosInstance> {
		if (this.client) return this.client;
		if (!this.clientReady) {
			this.clientReady = (async () => {
				let agent: HttpsProxyAgent<string> | SocksProxyAgent | undefined;
				if (this.rawProxyUrl) {
					const resolvedUrl = await resolveReachableProxyUrl(this.rawProxyUrl);
					agent = buildAgent(resolvedUrl);
				}
				const client = axios.create({
					timeout: 120_000,
					httpAgent: agent,
					httpsAgent: agent,
					proxy: false, // disable axios' own env-based proxy detection, we set the agent explicitly
				});
				this.client = client;
				return client;
			})();
		}
		return this.clientReady;
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
			proxyUrl: this.rawProxyUrl,
		});
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

		const client = await this.getClient();
		const { data } = await client.post(url, body, {
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
