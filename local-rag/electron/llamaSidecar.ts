import { app } from "electron";
import path from "node:path";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import net from "node:net";

type SidecarStatus = "stopped" | "starting" | "running" | "error";

export class LlamaSidecar {
    private proc: ChildProcessWithoutNullStreams | null = null;
    private status: SidecarStatus = "stopped";
    private port: number = 0;
    private baseUrl: string = "";

    getStatus() {
        return { status: this.status, port: this.port, baseUrl: this.baseUrl };
    }

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

    private modelPath() {
        const base = this.resourcesBase();
        return path.join(base, "models", "Phi-4-mini-instruct-Q4_K_M.gguf");
    }

    private async getFreePort(): Promise<number> {
        return await new Promise((resolve, reject) => {
            const srv = net.createServer();
            srv.listen(0, "127.0.0.1", () => {
                const addr = srv.address();
                srv.close(() => {
                    if (typeof addr === "object" && addr?.port) resolve(addr.port);
                    else reject(new Error("Failed to acquire free port"));
                });
            });
            srv.on("error", reject);
        });
    }

    private async waitUntilReady(baseUrl: string, timeoutMs = 20_000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            try {
                const res = await fetch(`${baseUrl}/v1/models`);
                if (res.ok) return;
            } catch {
                // ignore until ready
            }
            await new Promise((r) => setTimeout(r, 250));
        }
        throw new Error("llama-server did not become ready in time");
    }

    async start() {
        if (this.proc || this.status === "starting" || this.status === "running") return;

        this.status = "starting";
        this.port = await this.getFreePort();
        this.baseUrl = `http://127.0.0.1:${this.port}`;

        const bin = this.binPath();
        const model = this.modelPath();

        // Typical llama-server args (tune as needed)
        const args = [
            "--host", "127.0.0.1",
            "--port", String(this.port),

            "-m", model,

            // Chat defaults:
            "--ctx-size", "4096",
            "--threads", "4",

            // You can also set:
            // "--n-gpu-layers", "999",   // if using GPU layers on supported platforms/builds
        ];

        this.proc = spawn(bin, args, {
            cwd: path.dirname(bin),
            env: {
                ...process.env,
                // ensure dynamic libs can be found (mac often needs this)
                DYLD_LIBRARY_PATH: path.join(this.resourcesBase(), "bin"),
            },
            stdio: "pipe",
        });

        this.proc.stdout.on("data", (d) => {
            // Optional: forward to a log window / file
            // console.log("[llama]", d.toString());
        });

        this.proc.stderr.on("data", (d) => {
            // console.error("[llama:err]", d.toString());
        });

        this.proc.on("error", (err) => {
            console.error("Failed to start process:", err);
        });

        this.proc.on("exit", (code, signal) => {
            console.error(`llama-server exited. code=${code} signal=${signal}`);
            this.proc = null;
            this.status = "stopped";
        });

        try {
            await this.waitUntilReady(this.baseUrl);
            this.status = "running";
            console.log("llama-server is running at ", this.baseUrl);
        } catch (e) {
            this.status = "error";
            this.stop();
            throw e;
        }
    }

    stop() {
        if (!this.proc) return;
        this.proc.kill();
        this.proc = null;
        this.status = "stopped";
    }

    async chatCompletions(payload: any) {
        if (this.status !== "running") throw new Error("Sidecar not running");
        const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            const txt = await res.text();
            throw new Error(`llama-server error ${res.status}: ${txt}`);
        }
        return await res.json();
    }
}