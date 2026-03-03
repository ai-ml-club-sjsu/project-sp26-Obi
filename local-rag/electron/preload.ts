import { contextBridge } from "electron"

// Example API
contextBridge.exposeInMainWorld("api", {
    ping: () => "pong"
})