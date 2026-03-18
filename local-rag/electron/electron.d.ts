export { }

declare global {
    interface Window {
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

export type SidecarStatus = "stopped" | "starting" | "running" | "error";