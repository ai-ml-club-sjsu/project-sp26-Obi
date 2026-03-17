import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { SidecarStatus } from "./electron";
import { app } from "electron";
import path from "node:path";
import net from "node:net";

type EmbeddingResponse = {
    data: Array<{
        embedding: number[]
        index?: number
    }>
}

export class EmbedSidecar {
    private proc: ChildProcessWithoutNullStreams | null = null;
    private status: SidecarStatus = "stopped";
    private port: number = 0;
    private baseUrl: string = "";
    private hostUrl: string = "127.0.0.1";

    // Helpers
    private resourcesBase() {
        // In production, packaged files live under process.resourcesPath
        // In dev, use your repo resources folder
        return app.isPackaged
            ? process.resourcesPath
            : path.resolve(app.getAppPath(), "resources");
    }

    private binPath() {
        const base = this.resourcesBase();
        // mac example; you’ll need per-platform logic
        // If you ship other platforms, choose executable names accordingly.
        const exe = process.platform === "win32" ? "llama-server.exe" : "llama-server";
        return path.join(base, "bin", exe);
    }

    private embedModelPath() {
        const base = this.resourcesBase();
        return path.join(base, "models", "nomic-embed-text-v2-moe.Q4_K_M.gguf");

    }

    private async getFreePort(): Promise<number> {
        return await new Promise((resolve, reject) => {
            const srv = net.createServer();
            srv.listen(0, "127.0.0.1", () => {
                const addr = srv.address();
                srv.close(() => {
                    if (typeof addr === "object" && addr?.port) resolve(addr.port);
                    else reject(new Error("Failed to acquire free port for embedd model"));
                });
            });
            srv.on("error", reject);
        });
    }

    // Lifecycle
    async start() {
        if (this.proc || this.status === "starting" || this.status === "running") return;

        this.status = "starting";
        this.port = await this.getFreePort();
        this.baseUrl = `http://${this.hostUrl}:${this.port}`;

        const bin = this.binPath();
        const model = this.embedModelPath();

        const args = [
            "--host", this.hostUrl,
            "--port", String(this.port),
            "-m", model,
            "--embeddings",
            "--pooling", "mean",    // nomic-embed uses mean pooling
            "--ctx-size", "8192",   // nomic-v2 supports up to 8192 tokens
            "--batch-size", "512",  // tune to your RAM; affects throughput
        ];

        this.proc = spawn(bin, args, {
            cwd: path.dirname(bin),
            env: {
                ...process.env,
                ...(process.platform === "darwin"
                    ? { DYLD_LIBRARY_PATH: path.join(this.resourcesBase(), "bin") }
                    : process.platform === "linux"
                        ? { LD_LIBRARY_PATH: path.join(this.resourcesBase(), "bin") }
                        : {}),
            },
            stdio: "pipe",
        });

        this.proc.on("error", (err) => {
            this.proc = null;
            this.status = "error";
            console.error("embed-server process error:", err);
        });

        this.proc.on("exit", (code, signal) => {
            this.proc = null;
            // If it dies unexpectedly while starting/running, mark error
            this.status = (this.status === "starting" || this.status === "running") ? "error" : "stopped";
            console.error(`embed-server exited. code=${code} signal=${signal}`);
        });

        try {
            await this.waitUntilReady(this.baseUrl);
            this.status = "running";
            console.log("embed-server is running at ", this.baseUrl);
        } catch (e) {
            this.status = "error";
            this.stop();
            throw e;
        }
    }

    stop() {
        if (this.proc) {
            this.proc.kill();
            this.proc = null;
        }
        this.status = "stopped";
    }

    getStatus() {
        return { status: this.status, port: this.port, baseUrl: this.baseUrl };
    }

    private async waitUntilReady(baseUrl: string, timeoutMs = 15_000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            try {
                const res = await fetch(`${baseUrl}/health`); // Canonical choice for checking llama.cpp server status
                if (res.ok) return;
            } catch {
                // ignore
            }
            await new Promise((r) => setTimeout(r, 250));
        }
        throw new Error("Nomic embedding sidecar failed to become ready");
    }

    // Embedding calls 
    async embed(input: string | string[]) {
        if (this.status !== "running") await this.start()

        const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ input }),
        })

        if (!res.ok) {
            const txt = await res.text().catch(() => "")
            throw new Error(`Embeddings HTTP ${res.status}: ${txt}`)
        }

        return (await res.json()) as EmbeddingResponse
    }

    async embedOne(text: string): Promise<number[]> {
        const json = await this.embed(text)
        const vector = json.data?.[0]?.embedding

        if (!vector || !Array.isArray(vector)) {
            throw new Error("Embedding response missing data[0].embedding")
        }

        return vector
    }

    async embedMany(texts: string[]): Promise<number[][]> {
        const json = await this.embed(texts)
        const vectors = json.data?.map((item) => item.embedding)

        if (!vectors || vectors.length !== texts.length) {
            throw new Error("Embedding response length mismatch")
        }

        return vectors
    }

}