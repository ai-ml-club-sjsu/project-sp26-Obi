import { useState } from "react"

function FileWatcherPicker() {
    const [watchedPath, setWatchedPath] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)

    async function handlePick() {
        setLoading(true)
        try {
            const result = await window.watcher.pickDirectory()
            if (!result.canceled && result.path) {
                setWatchedPath(result.path)
            }
        } finally {
            setLoading(false)
        }
    }

    return (
        <div>
            <button onClick={handlePick} disabled={loading}>
                {loading ? "Opening…" : "Choose folder to watch"}
            </button>
            {watchedPath && (
                <p>Watching: <code>{watchedPath}</code></p>
            )}
        </div>
    )
}

export default FileWatcherPicker;