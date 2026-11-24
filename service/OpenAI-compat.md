# OpenAI-compatible API

Summeretto serves Gemini and OpenAI-compatible HTTP APIs from one process and one port. Start it normally:

```bash
cd service
node server.mjs
```

With the default `PORT=3000`, configure clients as follows:

| API | Base URL | Endpoints |
|---|---|---|
| Gemini | `http://127.0.0.1:3000` | `/v1beta/models`, `/v1beta/models/{model}:generateContent` |
| OpenAI | `http://127.0.0.1:3000/v1` | `/models`, `/chat/completions` |

There is no standalone compatibility server and nothing listens on port 8081.

## Authentication

Both API formats use the same `PROXY_API_KEY`. Configure an OpenAI-compatible client with that value as its API key. The server accepts either:

```http
Authorization: Bearer <PROXY_API_KEY>
```

or:

```http
x-goog-api-key: <PROXY_API_KEY>
```

If `PROXY_API_KEY` is empty, neither API format requires a key. Bind the server to `127.0.0.1` or set a strong key before exposing it beyond your machine.

## Supported OpenAI routes

- `GET /v1/models`
- `POST /v1/chat/completions`
- Streaming responses (`stream: true`)
- System/developer messages, data-URI images, and function tools

OpenAI requests are translated internally to the service's Gemini API, so they share the same model selection, retry, tool-call, and authentication behavior.
