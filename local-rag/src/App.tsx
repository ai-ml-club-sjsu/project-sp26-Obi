import { useEffect, useMemo, useRef, useState } from "react";
import FileWatcherPicker from "./components/FileWatcherPicker";
import type { SearchResult } from "./types/global";

type Msg = { role: "system" | "user" | "assistant"; content: string };
type Status = { status: "stopped" | "starting" | "running" | "error"; port: number; baseUrl: string };

function App() {
    const [chatModelReady, setChatModelReady] = useState(false);
    const [chatModelStatus, setChatModelStatus] = useState<Status | null>(null);
    const [starting, setStarting] = useState(true);

    const [input, setInput] = useState("");
    const [messages, setMessages] = useState<Msg[]>([
        { role: "system", content: "You are a helpful assistant." },
    ]);
    const [lastRetrieved, setLastRetrieved] = useState<SearchResult[]>([]);

    const [isGenerating, setIsGenerating] = useState(false);
    const [lastError, setLastError] = useState<string | null>(null);

    const endRef = useRef<HTMLDivElement | null>(null);
    const messagesRef = useRef<Msg[]>(messages);

    useEffect(() => {
        messagesRef.current = messages;
        // auto-scroll to bottom
        endRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    const chatModelStatusLabel = useMemo(() => {
        if (!chatModelStatus) return "unknown";
        return chatModelStatus.status;
    }, [chatModelStatus]);

    const statusStyle: React.CSSProperties = useMemo(() => {
        const base: React.CSSProperties = {
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 10px",
            borderRadius: 999,
            fontSize: 12,
            border: "1px solid #ddd",
            userSelect: "none",
        };
        if (!chatModelStatus) return base;
        if (chatModelStatus.status === "running") return { ...base, borderColor: "#b7eb8f" };
        if (chatModelStatus.status === "starting") return { ...base, borderColor: "#ffe58f" };
        if (chatModelStatus.status === "error") return { ...base, borderColor: "#ffa39e" };
        return base;
    }, [chatModelStatus]);

    useEffect(() => {
        let mounted = true;

        (async () => {
            setStarting(true);
            setLastError(null);
            try {
                await window.llama.start();
                await window.api.embedder.start();
                const st: Status = await window.llama.status();
                if (!mounted) return;
                setChatModelStatus(st);
                setChatModelReady(st.status === "running" || st.status === "starting"); // allow UI; chat guarded below
            } catch (e: any) {
                if (!mounted) return;
                setLastError(String(e?.message ?? e));
                setChatModelReady(false);
                setChatModelStatus({ status: "error", port: 0, baseUrl: "" });
            } finally {
                if (mounted) setStarting(false);
            }
        })();

        const interval = setInterval(async () => {
            try {
                const st: Status = await window.llama.status();
                if (mounted) setChatModelStatus(st);
            } catch {
                // ignore
            }
        }, 1500);

        return () => {
            mounted = false;
            clearInterval(interval);
        };
    }, []);

    const stop = () => {
        try {
            window.llama.chatStreamCancel?.();
        } catch {
            // ignore
        }
        setIsGenerating(false);
    };

    const send = async () => {
        const content = input.trim();
        if (!content || isGenerating) return;

        setLastError(null);
        setInput("");

        const userMsg: Msg = { role: "user", content };

        // Optimistic UI update: add user message + empty assistant message (we'll fill it with deltas)
        setMessages((prev) => [...prev, userMsg, { role: "assistant", content: "" }]);

        // Unique requestId for routing events
        const requestId =
            (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);

        setIsGenerating(true);

        // NEW: retrieve relevant chunks before calling the model
        let ragResults: SearchResult[] = [];
        let ragSystemMsg: Msg | null = null;

        try {
            ragResults = await window.api.rag.search(content, 5);
            setLastRetrieved(ragResults);
            ragSystemMsg = buildRagSystemMessage(ragResults);
        } catch (e: any) {
            // retrieval failure should not necessarily block chat
            console.error("RAG search failed:", e);
            setLastError(`RAG search failed: ${String(e?.message ?? e)}`);
        }

        const history = messagesRef.current;
        const nextMessages = ragSystemMsg
            ? [...history, ragSystemMsg, userMsg]
            : [...history, userMsg];


        // Subscribe to streaming events
        const offDelta = window.llama.onChatStreamDelta?.((payload: any) => {
            if (payload?.requestId !== requestId) return;
            const delta = String(payload?.delta ?? "");
            if (!delta) return;

            setMessages((prev) => {
                const i = prev.length - 1;
                const last = prev[i];
                if (!last || last.role !== "assistant") return prev;

                const next = prev.slice();
                next[i] = { ...last, content: last.content + delta };
                return next;
            });
        });

        const cleanup = () => {
            try { offDelta?.(); } catch { }
            try { offDone?.(); } catch { }
            try { offErr?.(); } catch { }
        };

        const offDone = window.llama.onChatStreamDone?.((payload: any) => {
            if (payload?.requestId !== requestId) return;
            setIsGenerating(false);
            cleanup();
        });

        const offErr = window.llama.onChatStreamError?.((payload: any) => {
            if (payload?.requestId !== requestId) return;
            setIsGenerating(false);
            setLastError(String(payload?.error ?? "Unknown error"));
            // Replace the empty assistant bubble with the error (or append)
            setMessages((prev) => {
                const copy = [...prev];
                const last = copy[copy.length - 1];
                if (last?.role === "assistant" && !last.content) {
                    last.content = `⚠️ ${String(payload?.error ?? "Unknown error")}`;
                    return copy;
                }
                return [...copy, { role: "assistant", content: `⚠️ ${String(payload?.error ?? "Unknown error")}` }];
            });
            cleanup();
        });

        // Start the stream
        try {
            if (!window.llama.chatStreamStart) {
                throw new Error("Streaming API not available on window.llama");
            }
            window.llama.chatStreamStart({
                requestId,
                messages: nextMessages,
                temperature: 0.2,
            });
        } catch (e: any) {
            setIsGenerating(false);
            setLastError(String(e?.message ?? e));
            cleanup();
        }
    };

    const buildRagSystemMessage = (results: SearchResult[]): Msg | null => {
        if (!results.length) return null;

        const context = results
            .map((r, i) => {
                return [
                    `Source ${i + 1}:`,
                    `File: ${r.fileName}`,
                    `Path: ${r.documentPath}`,
                    `Distance: ${r.distance}`,
                    `Content:`,
                    r.content,
                ].join("\n");
            })
            .join("\n\n---\n\n");

        return {
            role: "system",
            content:
                "Use the retrieved context below to answer the user's question. " +
                "Prefer the retrieved context when it is relevant. " +
                "If the context is insufficient, say so plainly.\n\n" +
                context,
        };
    };

    return (
        <div
            style={{
                padding: 16,
                maxWidth: 980,
                margin: "0 auto",
                fontFamily:
                    'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"',
            }}
        >
            <header
                style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    marginBottom: 12,
                }}
            >
                <div>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                        <h2 style={{ margin: 0 }}>Local Chatbot</h2>
                        <FileWatcherPicker />
                        <span style={statusStyle}>
                            <span
                                style={{
                                    width: 8,
                                    height: 8,
                                    borderRadius: 999,
                                    background:
                                        chatModelStatusLabel === "running"
                                            ? "#52c41a"
                                            : chatModelStatusLabel === "starting"
                                                ? "#faad14"
                                                : chatModelStatusLabel === "error"
                                                    ? "#ff4d4f"
                                                    : "#bfbfbf",
                                }}
                            />
                            <span style={{ textTransform: "capitalize" }}>
                                {starting ? "starting…" : chatModelStatusLabel}
                            </span>
                            {chatModelStatus?.baseUrl ? (
                                <span style={{ opacity: 0.7 }}>{chatModelStatus.baseUrl}</span>
                            ) : null}
                        </span>
                    </div>
                    <div style={{ marginTop: 6, color: "#666", fontSize: 13 }}>
                        {starting && "Booting local model…"}
                        {!starting && chatModelStatus?.status === "running" && "Chat Model Ready."}
                        {!starting && chatModelStatus?.status === "error" && "Sidecar error — check logs."}
                    </div>
                </div>

                <div style={{ display: "flex", gap: 8 }}>
                    <button
                        onClick={async () => {
                            setStarting(true);
                            setLastError(null);
                            try {
                                await window.llama.start();
                                const st: Status = await window.llama.status();
                                setChatModelStatus(st);
                                setChatModelReady(true);
                            } catch (e: any) {
                                setLastError(String(e?.message ?? e));
                            } finally {
                                setStarting(false);
                            }
                        }}
                        disabled={starting}
                        style={{
                            padding: "8px 10px",
                            borderRadius: 10,
                            border: "1px solid #ddd",
                            background: "#fff",
                            cursor: starting ? "not-allowed" : "pointer",
                        }}
                    >
                        Restart
                    </button>

                    <button
                        onClick={stop}
                        disabled={!isGenerating}
                        style={{
                            padding: "8px 10px",
                            borderRadius: 10,
                            border: "1px solid #ddd",
                            background: isGenerating ? "#fff" : "#fafafa",
                            cursor: isGenerating ? "pointer" : "not-allowed",
                        }}
                    >
                        Stop
                    </button>
                </div>
            </header>

            {lastError ? (
                <div
                    style={{
                        border: "1px solid #ffa39e",
                        background: "#fff1f0",
                        color: "#a8071a",
                        padding: 10,
                        borderRadius: 12,
                        marginBottom: 12,
                        fontSize: 13,
                        whiteSpace: "pre-wrap",
                    }}
                >
                    {lastError}
                </div>
            ) : null}

            <div
                style={{
                    border: "1px solid #e5e5e5",
                    borderRadius: 16,
                    padding: 12,
                    height: 520,
                    overflow: "auto",
                    background: "#fff",
                }}
            >
                {messages
                    .filter((m) => m.role !== "system")
                    .map((m, i) => {
                        const isUser = m.role === "user";
                        return (
                            <div
                                key={i}
                                style={{
                                    display: "flex",
                                    justifyContent: isUser ? "flex-end" : "flex-start",
                                    marginBottom: 10,
                                }}
                            >
                                <div
                                    style={{
                                        maxWidth: "82%",
                                        padding: "10px 12px",
                                        borderRadius: 14,
                                        border: "1px solid #eee",
                                        background: isUser ? "#f6ffed" : "#f5f5f5",
                                        whiteSpace: "pre-wrap",
                                        lineHeight: 1.35,
                                    }}
                                >
                                    <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 4 }}>
                                        {isUser ? "You" : "Assistant"}
                                    </div>
                                    <div style={{ fontSize: 14 }}>
                                        {m.content || (m.role === "assistant" && isGenerating ? "…" : "")}
                                    </div>
                                </div>
                            </div>
                        );
                    })}

                <div ref={endRef} />
            </div>

            {/* RAG Results */}
            {lastRetrieved.length > 0 ? (
                <div
                    style={{
                        marginTop: 12,
                        border: "1px solid #e5e5e5",
                        borderRadius: 12,
                        padding: 12,
                        background: "#fafafa",
                    }}
                >
                    <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
                        Retrieved context
                    </div>

                    <div
                        style={{
                            display: "flex",
                            flexDirection: "row",
                            gap: 8,
                            flexWrap: "wrap",
                        }}
                    >
                        {lastRetrieved.map((r) => (
                            <div
                                key={r.chunkId}
                                style={{
                                    padding: 10,
                                    border: "1px solid #eee",
                                    borderRadius: 10,
                                    background: "#fff",
                                }}
                            >
                                <div style={{ fontSize: 12, marginBottom: 4 }}>
                                    {r.fileName}
                                </div>
                                <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>
                                    distance {r.distance.toFixed(2)}
                                </div>
                                {/* <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>
                                    {r.content}
                                </div> */}
                            </div>
                        ))}
                    </div>
                </div>
            ) : null}

            {/* Input */}
            <div style={{ marginTop: 12 }}>
                <textarea
                    style={{
                        width: "100%",
                        padding: 12,
                        borderRadius: 14,
                        border: "1px solid #ddd",
                        resize: "none",
                        minHeight: 90,
                        fontFamily: "inherit",
                        fontSize: 14,
                        outline: "none",
                    }}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
                    disabled={!chatModelReady || starting}
                    onKeyDown={(e) => {
                        // Enter sends; Shift+Enter inserts newline
                        if (e.key === "Enter" && !e.shiftKey && !(e as any).isComposing) {
                            e.preventDefault();
                            send();
                        }
                    }}
                />

                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10 }}>
                    <div style={{ fontSize: 12, color: "#888" }}>
                        {isGenerating ? "Generating…" : " "}
                    </div>
                    <button
                        onClick={send}
                        disabled={!chatModelReady || starting || isGenerating || !input.trim()}
                        style={{
                            padding: "10px 14px",
                            borderRadius: 12,
                            border: "1px solid #ddd",
                            background: !chatModelReady || starting || isGenerating || !input.trim() ? "#fafafa" : "#fff",
                            cursor: !chatModelReady || starting || isGenerating || !input.trim() ? "not-allowed" : "pointer",
                        }}
                    >
                        Send
                    </button>
                </div>
            </div>
        </div>
    );
}

export default App;