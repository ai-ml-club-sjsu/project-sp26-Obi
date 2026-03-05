import { useEffect, useMemo, useState } from "react";

type Msg = { role: "system" | "user" | "assistant"; content: string };

function App() {
    const [ready, setReady] = useState(false);
    const [input, setInput] = useState("");
    const [messages, setMessages] = useState<Msg[]>([
        { role: "system", content: "You are a helpful assistant." },
    ]);

    useEffect(() => {
        (async () => {
            await window.llama.start();
            setReady(true);
        })();
    }, []);

    const send = async () => {
        const userMsg: Msg = { role: "user", content: input };
        setInput("");
        setMessages((m) => [...m, userMsg]);

        const res = await window.llama.chat([...messages, userMsg]);
        const text =
            res?.choices?.[0]?.message?.content ??
            res?.choices?.[0]?.delta?.content ??
            "(no response)";

        setMessages((m) => [...m, { role: "assistant", content: text }]);
    };

    return (
        <div style={{ padding: 16, maxWidth: 900, margin: "0 auto" }}>
            <h2>Local Chatbot</h2>
            {!ready && <div>Starting model…</div>}

            <div
                style={{
                    border: "1px solid #ddd",
                    padding: 12,
                    height: 420,
                    overflow: "auto",
                }}
            >
                {messages
                    .filter((m) => m.role !== "system")
                    .map((m, i) => (
                        <div key={i} style={{ marginBottom: 10 }}>
                            <b>{m.role}:</b> {m.content}
                        </div>
                    ))}
            </div>

            <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                <input
                    style={{ flex: 1, padding: 8 }}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && send()}
                    placeholder="Type a message…"
                    disabled={!ready}
                />
                <button onClick={send} disabled={!ready || !input.trim()}>
                    Send
                </button>
            </div>
        </div>
    );
}

export default App;
