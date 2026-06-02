# Empire TV Chat Backend v3

WebSocket-first real-time chat + HTTP fallback + arquivo de transmissões persistido na planilha Google Sheets.

## Endpoints

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/ping` | Healthcheck |
| GET | `/online/:roomId` | Usuários online na sala |
| GET | `/messages/:roomId` | Histórico HTTP (fallback) |
| POST | `/send` | Enviar mensagem HTTP (fallback) |
| POST | `/room/meta` | Registrar metadados da sala |
| POST | `/room/close` | Encerrar transmissão e arquivar |
| GET | `/archive` | Listar transmissões encerradas |
| GET | `/archive/:roomId` | Detalhes + chat de um arquivo |
| GET | `/participacao/:roomId` | Ranking da sala |
| WS | `/ws?roomId=&userId=&nome=` | Conexão WebSocket |

## Variáveis de ambiente

```
PORT=10000
WORKER_SECRET=sua_chave_secreta
GAS_ARCHIVE_URL=https://script.google.com/macros/s/.../exec
```

## Fluxo WebSocket

1. Frontend conecta em `wss://host/ws?roomId=CHAT_ID&userId=USER_ID&nome=NOME`
2. Backend envia `{ type: "history", messages: [...] }` imediatamente
3. Para enviar mensagem: `{ type: "message", texto: "..." }`
4. Broadcast instantâneo para toda a sala
5. Ao encerrar: backend envia `{ type: "room_closed" }` e fecha conexões

## Arquivo de transmissões

Ao chamar `POST /room/close`, o backend:
- Move a sala para memória de arquivo (`archive[]`)
- Chama o Apps Script via `GAS_ARCHIVE_URL` para salvar em JSON na aba `TV_ChatArchive`
- Notifica todos os clientes conectados
