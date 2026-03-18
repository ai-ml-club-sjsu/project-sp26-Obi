export { };

type ChatRole = "system" | "user" | "assistant";

export type Msg = {
    role: ChatRole;
    content: string;
};

export type SearchResult = {
    chunkId: number
    documentPath: string
    fileName: string
    content: string
    distance: number
}

export type SidecarStatus = "stopped" | "starting" | "running" | "error";

export type LlamaStatus = {
    status: SidecarStatus;
    port: number;
    baseUrl: string;
};

export interface LlamaApi {
    // Lifecycle
    start(): Promise<LlamaStatus>;
    status(): Promise<LlamaStatus>;
    stop(): Promise<LlamaStatus>;

    // Streaming
    chatStreamStart(params: {
        requestId: string;
        messages: Msg[];
        temperature?: number;
    }): void;

    chatStreamCancel(): void;

    onChatStreamDelta(
        cb: (payload: { requestId: string; delta: string }) => void
    ): () => void;

    onChatStreamDone(
        cb: (payload: { requestId: string }) => void
    ): () => void;

    onChatStreamError(
        cb: (payload: { requestId: string; error: string }) => void
    ): () => void;
}

export

declare global {
    interface Window {
        llama: LlamaApi;

        api: {
            rag: {
                search: (
                    query: string,
                    limit?: number
                ) => Promise<
                    Array<{
                        chunkId: number
                        documentPath: string
                        fileName: string
                        content: string
                        distance: number
                    }>
                >
            }

            embedder: {
                start: () => Promise<{
                    status: string
                    port: number
                    baseUrl: string
                }>
                stop: () => Promise<{
                    status: string
                    port: number
                    baseUrl: string
                }>
                status: () => Promise<{
                    status: string
                    port: number
                    baseUrl: string
                }>
            }

        }

        watcher: {
            start: (rootPath: string) => Promise<{ status: string; rootPath: string | null }>
            stop: () => Promise<{ status: string; rootPath: string | null }>
            status: () => Promise<{ status: string; rootPath: string | null }>
            pickDirectory: () => Promise<{ canceled: boolean; path: string | null }>
        }
    }
}