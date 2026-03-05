import { contextBridge, ipcRenderer } from "electron"

// Example API
contextBridge.exposeInMainWorld("api", {
    ping: () => "pong"
})

contextBridge.exposeInMainWorld("llama", {
    start: () => ipcRenderer.invoke("llama:start"),
    status: () => ipcRenderer.invoke("llama:status"),
    stop: () => ipcRenderer.invoke("llama:stop"),
    chat: (messages: Array<{ role: string; content: string }>) =>
        ipcRenderer.invoke("llama:chat", messages),
});