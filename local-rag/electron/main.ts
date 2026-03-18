import { app, BrowserWindow, ipcMain, dialog } from "electron"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { LlamaSidecar } from "./llamaSidecar.js";
import { EmbedSidecar } from "./embedSidecar.js";
import { VectorStore } from "./vectorStore.js";
import { initDatabase } from "./database.js";
import { FileWatcher } from "./fileWatcher.js";

// -- Developer Mode Check -----------------------------
const isDev = !app.isPackaged // Packaged means not developer, not packaged means developer mode
// if (isDev) console.log("Dev URL:", process.env.VITE_DEV_SERVER_URL);

/* -- Module paths in ESM -------------------------------
Because package.json has "type": "module", .js files are treated as ESM (ECMAScript Modules).
ESM uses `import` / `export` and does not provide CommonJS globals like `__filename` and `__dirname`.

To get the current file and directory (CommonJS-style), we derive them from `import.meta.url`.
This is useful for building paths relative to this module (e.g., preload.ts).
*/
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/* - Chat Setting Variables -----------
*/
const chatModelTemperature = 0.2;

/* - LlamaSidecar IPC handler -----------------------------------
Main-process handlers manage the LlamaSidecar lifecycle (ipcMain.handle).
preload.ts exposes a safe renderer API (via contextBridge) that calls those
handlers using ipcRenderer.invoke, limiting what the frontend can access.

llama:start
llama:status
llama:stop
*/
const llama = new LlamaSidecar(); // Single sidecar instance for chatting (Qwen 3.5 currently)

// sidecar lifecycle
function registerLlamaIpc() {
    ipcMain.handle("llama:start", async () => {
        await llama.start();
        return llama.getStatus();
    });

    ipcMain.handle("llama:status", async () => {
        return llama.getStatus();
    });

    ipcMain.handle("llama:stop", async () => {
        llama.stop();
        return llama.getStatus();
    });
}

/* -- Chat Model Streaming IPC -----------------------
steamAborters: { webContent.id : AbortController}
------------------------------------------------------
llama:chat_stream_start
ARGS
- requestId: For React to match deltas (Determines which page the stream gets rendered to)
- messages: Chat history
- temperature: Model temp, refer to chatModelTemperature
------------------------------------------------------
llama:chat_stream_cancel
DESC
- React calls ipcRenderer => emits llama:chat_stream_cancel to abort stream
*/
const streamAborters = new Map<number, AbortController>(); // { requestId: }

ipcMain.on("llama:chat_stream_start", async (event, { requestId, messages, temperature }) => {
    // Ensure sidecar running, otherwise emit "llama:chat_stream_error" err msg for frontend rendering
    if (llama.getStatus().status !== "running") {
        try { await llama.start(); } catch (e: any) {
            event.sender.send("llama:chat_stream_error", { requestId, error: String(e?.message ?? e) });
            return;
        }
    }

    // Registoring the webContent ID to allow the ability to cancel per stream
    const wcId = event.sender.id;
    const ac = new AbortController();
    streamAborters.set(wcId, ac);

    try {
        // Start fetch to local server with "stream: true" (SSE)
        const res = await fetch(`${llama.getStatus().baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: ac.signal,
            body: JSON.stringify({
                model: "local-model",
                messages,
                temperature: temperature ?? chatModelTemperature,
                stream: true,
            }),
        });

        // If fetch request fails, send error
        if (!res.ok || !res.body) {
            const txt = await res.text().catch(() => "");
            event.sender.send("llama:chat_stream_error", {
                requestId,
                error: `HTTP ${res.status}: ${txt}`,
            });
            return;
        }

        // Tell renderer stream started
        event.sender.send("llama:chat_stream_started", { requestId });

        // Read SSE text stream
        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

        // Stream is bytes => decode to text => parse SSE frames
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true }); // decode to text

            // SSE frames separated by \n\n
            let idx;
            while ((idx = buffer.indexOf("\n\n")) !== -1) {
                const frame = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);

                // SSE lines: "data: {...}"
                for (const line of frame.split("\n")) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith("data:")) continue;

                    const data = trimmed.slice(5).trim();
                    if (!data) continue;

                    if (data === "[DONE]") {
                        event.sender.send("llama:chat_stream_done", { requestId });
                        streamAborters.delete(wcId);
                        return;
                    }

                    // parse JSON chunk (OpenAI-style)
                    try {
                        const json = JSON.parse(data);
                        const delta = json?.choices?.[0]?.delta?.content ?? "";
                        if (delta) {
                            event.sender.send("llama:chat_stream_delta", { requestId, delta });
                        }
                    } catch {
                        // ignore malformed chunk
                    }
                }
            }
        }

        event.sender.send("llama:chat_stream_done", { requestId });
    } catch (e: any) {
        const aborted = e?.name === "AbortError";
        event.sender.send("llama:chat_stream_error", {
            requestId,
            error: aborted ? "aborted" : String(e?.message ?? e),
        });
    } finally {
        streamAborters.delete(event.sender.id);
    }
});

ipcMain.on("llama:chat_stream_cancel", (event) => {
    const ac = streamAborters.get(event.sender.id);
    if (ac) ac.abort();
    streamAborters.delete(event.sender.id);
});

/* - EmbedSidecar IPC handler -----------------------
*/
const embedder = new EmbedSidecar();

function registerEmbedIpc() {
    ipcMain.handle("embedder:start", async () => {
        await embedder.start();
        return embedder.getStatus();
    });

    ipcMain.handle("embedder:stop", async () => {
        embedder.stop();
        return embedder.getStatus();
    });

    ipcMain.handle("embedder:status", async () => {
        return embedder.getStatus();
    });
}

/* - VectorStore(RAG) IPC handler -----------------------
*/

const vectorStore = new VectorStore(
    (text) => embedder.embedOne(text),
    (texts) => embedder.embedMany(texts),
    768 // make sure this matches your actual model output size
)

function registerRAGIpc() {
    // ipcMain.handle("rag:indexDirectory", async (_event, rootPath: string) => {
    //     return vectorStore.indexDirectory(rootPath)
    // })

    // ipcMain.handle("rag:indexFile", async (_event, filePath: string) => {
    //     return vectorStore.indexFile(filePath)
    // })

    ipcMain.handle("rag:search", async (_event, query: string, limit = 5) => {
        return vectorStore.search(query, limit)
    })
}
/* - FileWatcher IPC handler -----------------------
*/
const fileWatcher = new FileWatcher(vectorStore);
function registerFileWatcherIpc() {
    ipcMain.handle("watcher:start", async (_event, rootPath: string) => {
        await fileWatcher.start(rootPath)
        return fileWatcher.getStatus()
    })

    ipcMain.handle("watcher:stop", async () => {
        await fileWatcher.stop()
        return fileWatcher.getStatus()
    })

    ipcMain.handle("watcher:status", async () => {
        return fileWatcher.getStatus()
    })

    ipcMain.handle("watcher:pickDirectory", async (event) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        const result = await dialog.showOpenDialog(win!, {
            properties: ["openDirectory"],
            title: "Choose a folder to watch",
        })

        if (result.canceled || result.filePaths.length === 0) {
            return { canceled: true, path: null }
        }

        const selectedPath = result.filePaths[0]
        await fileWatcher.setPath(selectedPath)
        return { canceled: false, path: selectedPath }
    })
}

/* - Electron Main Process -----------------------
createWindow

app.whenReady()

app.on("activate")

app.on("window-all-closed")

app.on("before-quit")

*/
function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, "preload.mjs"),
            contextIsolation: true, // preload runs in isolated context
            nodeIntegration: false, // renderer can't import Node APIs directly
        },
    })

    if (isDev) {
        const devUrl = process.env.VITE_DEV_SERVER_URL ?? "http://localhost:5173";
        win.loadURL(devUrl);
        // win.webContents.openDevTools() // Auto opens dev tools
    } else {
        win.loadFile(path.join(__dirname, "../dist/index.html"))
    }
}

app.whenReady().then(async () => {
    try {
        initDatabase();     // Starts on App startup
        registerLlamaIpc(); // Called from frontend useEffect
        registerEmbedIpc(); // Called from frontend useEffect
        registerRAGIpc();   // Called from frontend search()
        registerFileWatcherIpc();

        createWindow();
    } catch (error) {
        console.error("❌ Startup Error:", error);
    }
});

app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
})

app.on("before-quit", () => {
    fileWatcher.stop();
    llama.stop();
    embedder?.stop();
});