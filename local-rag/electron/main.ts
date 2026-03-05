import { app, BrowserWindow, ipcMain } from "electron"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { LlamaSidecar } from "./llamaSidecar.js";

const isDev = !app.isPackaged
// if (isDev) console.log("Dev URL:", process.env.VITE_DEV_SERVER_URL);

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const llama = new LlamaSidecar();

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

    ipcMain.handle("llama:chat", async (_event, messages) => {
        return await llama.chatCompletions({
            model: "local-model",
            messages,
            temperature: 0.7,
            stream: false,
        });
    });
}

// - Creates window --------------------------
function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, "preload.mjs"),
            contextIsolation: true,
            nodeIntegration: false,
        },
    })

    if (isDev) {
        const devUrl = process.env.VITE_DEV_SERVER_URL ?? "http://localhost:5173";
        win.loadURL(devUrl);
        // win.webContents.openDevTools()
    } else {
        win.loadFile(path.join(__dirname, "../dist/index.html"))
    }
}

app.whenReady().then(async () => {
    registerLlamaIpc();
    createWindow();
});

app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
})

app.on("before-quit", () => {
    llama.stop();
});