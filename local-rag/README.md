# Obsidian RAG

## Install Guide (MAC)

In the CLI

- `git clone git@github.com:durpdur/Obsidian_RAG.git`
- Navigate to `local-rag` directory (Important!)
- `npm install`
- `npx electron-rebuild`
  - Fixes `The module better_sqlite3.node was compiled against a different Node.js version using`

In resources/models, place your `.gguf` models

Download `Qwen3.5-2B-Q4_K_M.gguf` for text model

- https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/tree/main

Download `nomic-embed-text-v2-moe.Q4_K_M.gguf` for embed model

- https://huggingface.co/nomic-ai/nomic-embed-text-v2-moe-GGUF/tree/main

### Potential Errors:

`Apple could not verify “llama-server” is free of malware that may harm your Mac or compromise your privacy.`

- You'll need to sign the binaries in order for mac to trust it, simply copy paste the error into chatGPT and it'll lead you through

---

## Install Guide (Windows)

Download llama.cpp binaries

- https://github.com/ggml-org/llama.cpp/releases?page=1

Replace the binaries in resources/bin

In progress...

---

## General

Before trying to push a change into the repo, please understand the below concepts.

- What is the main branch?
- What is a branch?
- What is a merge request?

- How to commit
- How to push
- how to pull

- How to handle a merge conflict

- [Git Basics](https://webtuu.com/blog/04/git-basics-branching-merging-push-to-github)
