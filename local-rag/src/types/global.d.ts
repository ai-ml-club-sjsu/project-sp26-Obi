export { };

type ChatRole = "system" | "user" | "assistant";
type ChatMessage = { role: ChatRole; content: string };

type LlamaStatus = { status: "stopped" | "starting" | "running" | "error"; port: number; baseUrl: string };

interface LlamaApi {
    start(): Promise<LlamaStatus>;
    status(): Promise<LlamaStatus>;
    stop(): Promise<LlamaStatus>;
    chat(messages: ChatMessage[]): Promise<any>; // or type this to match your server response
}

declare global {
    interface Window {
        llama: LlamaApi;
        api: {
            ping(): string;
        };
    }
}