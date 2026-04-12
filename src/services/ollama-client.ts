// Minimal Ollama HTTP client. Zero dependencies — just `fetch`.
// Ported verbatim from anabasis-f0-eval/src/ollama.ts (F0-validated).
// Works against either native Ollama (`brew install ollama && ollama serve`)
// or the docker-compose.yml in the project root. Both expose the same
// :11434 API.

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.ANABASIS_MODEL ?? "qwen2.5:14b-instruct-q5_K_M";

export type OllamaMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatOptions = {
  temperature?: number;
  numCtx?: number;
};

export async function chat(
  messages: OllamaMessage[],
  options: ChatOptions = {},
): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: false,
      options: {
        temperature: options.temperature ?? 0,
        num_ctx: options.numCtx ?? 8192,
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { message: { content: string } };
  return data.message.content;
}

export async function* chatStream(
  messages: OllamaMessage[],
  options: ChatOptions = {},
): AsyncGenerator<string> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: true,
      options: {
        temperature: options.temperature ?? 0,
        num_ctx: options.numCtx ?? 8192,
      },
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Ollama HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as {
          message?: { content?: string };
          done?: boolean;
        };
        if (obj.message?.content) yield obj.message.content;
      } catch {
        // ignore partial line — Ollama emits well-formed NDJSON, but
        // be defensive in case the stream is split mid-object.
      }
    }
  }
}

export function modelInfo() {
  return { url: OLLAMA_URL, model: MODEL };
}
