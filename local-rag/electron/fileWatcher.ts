import chokidar, { FSWatcher } from "chokidar"
import path from "node:path"
import { fileURLToPath } from "node:url";
import fs from "node:fs"
import { VectorStore } from "./vectorStore"
import { SidecarStatus } from "./electron"


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEXT_FILE_EXTENSIONS = new Set([".txt", ".md"])

export class FileWatcher {
    private watcher: FSWatcher | null = null
    private rootPath: string | null = null
    private status: SidecarStatus = "stopped"

    constructor(private readonly vectorStore: VectorStore) { }

    async setPath(newRootPath: string) {
        if (this.rootPath === newRootPath) return this.getStatus()
        await this.start(newRootPath)
        return this.getStatus()
    }

    async start(rootPath: string) {
        if (this.watcher) {
            await this.stop()
        }

        this.status = "starting"
        this.rootPath = rootPath

        this.watcher = chokidar.watch(rootPath, {
            persistent: true,
            ignoreInitial: false,
            awaitWriteFinish: {
                stabilityThreshold: 500,
                pollInterval: 100,
            },
        })

        this.watcher.on("add", async (filePath) => {
            if (!shouldIndexFile(filePath)) return
            try {
                await this.vectorStore.indexFile(filePath)
                console.log("[fileWatcher] indexed added file:", filePath)
            } catch (error) {
                this.status = "error";
                console.error("[fileWatcher] add failed:", filePath, error)
            }
        })

        this.watcher.on("change", async (filePath) => {
            if (!shouldIndexFile(filePath)) return
            try {
                await this.vectorStore.indexFile(filePath)
                console.log("[fileWatcher] reindexed changed file:", filePath)
            } catch (error) {
                this.status = "error";
                console.error("[fileWatcher] change failed:", filePath, error)
            }
        })

        this.watcher.on("unlink", async (filePath) => {
            if (!shouldIndexFile(filePath)) return
            try {
                await this.vectorStore.deleteDocument(filePath)
                console.log("[fileWatcher] removed deleted file:", filePath)
            } catch (error) {
                this.status = "error";
                console.error("[fileWatcher] unlink failed:", filePath, error)
            }
        })

        this.watcher.on("error", (error) => {
            this.status = "error"
            console.error("[fileWatcher] watcher error:", error)
        })

        this.status = "running"
    }

    async stop() {
        if (this.watcher) {
            await this.watcher.close()
            this.watcher = null
        }

        this.rootPath = null
        this.status = "stopped"
    }

    getStatus() {
        return {
            status: this.status,
            rootPath: this.rootPath,
        }
    }
}

function shouldIndexFile(filePath: string) {
    return TEXT_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}