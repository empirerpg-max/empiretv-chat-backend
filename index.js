const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// ─── Memória ──────────────────────────────────────────────────────────────────
// rooms[roomId] = { messages: ChatMsg[], clients: Set<WebSocket> }
const rooms = {};

function getRoom(roomId) {
  if (!rooms[roomId]) rooms[roomId] = { messages: [], clients: new Set() };
  return rooms[roomId];
}

function genId() {
  return "m_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2);
}

function wsSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room, payload, excludeWs) {
  room.clients.forEach((client) => {
    if (client !== excludeWs) wsSend(client, payload);
  });
}

function pushMessage(roomId, chatMsg) {
  const room = getRoom(roomId);
  room.messages.push(chatMsg);
  if (room.messages.length > 2000)
    room.messages = room.messages.slice(room.messages.length - 2000);
  return room;
}

// ─── HTTP endpoints ───────────────────────────────────────────────────────────

/** Healthcheck / warmup — chamado pelo frontend antes de abrir WS */
app.get("/ping", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

/**
 * GET /messages/:roomId?since=<iso>&limit=<n>
 * Polling HTTP puro — base garantida mesmo sem WebSocket.
 * O frontend usa isso como fallback (e como fonte primária enquanto o WS não conecta).
 */
app.get("/messages/:roomId", (req, res) => {
  const roomId = String(req.params.roomId || "").trim();
  if (!roomId) return res.status(400).json({ ok: false, error: "roomId obrigatório" });
  const room = getRoom(roomId);
  const since = req.query.since ? new Date(req.query.since).getTime() : 0;
  const limit = Math.min(parseInt(req.query.limit) || 60, 200);
  let msgs = since > 0
    ? room.messages.filter((m) => new Date(m.data).getTime() > since)
    : room.messages.slice(-limit);
  res.json({ ok: true, messages: msgs, ts: new Date().toISOString() });
});

/**
 * POST /send
 * Envia mensagem via HTTP — fallback garantido quando WS não está disponível.
 * Body: { roomId, userId, nome, texto, tipo?, gifUrl? }
 */
app.post("/send", (req, res) => {
  const { roomId, userId, nome, texto, tipo, gifUrl } = req.body || {};
  if (!roomId || !userId || (!texto && !gifUrl))
    return res.status(400).json({ ok: false, error: "dados incompletos" });

  const chatMsg = {
    id: genId(),
    tgId: String(userId),
    nome: String(nome || "Anon"),
    texto: String(texto || ""),
    tipo: tipo || "texto",
    gifUrl: gifUrl || "",
    data: new Date().toISOString(),
  };

  const room = pushMessage(String(roomId), chatMsg);
  // broadcast para clientes WS da sala
  broadcast(room, { type: "message", message: chatMsg });
  res.json({ ok: true, message: chatMsg });
});

/**
 * POST /participacao
 * Registra ou incrementa participação de um usuário.
 * Body: { roomId, userId, nome, programa, tipo? }
 * Retorna ranking completo da sala.
 */
app.post("/participacao", (req, res) => {
  const { roomId, userId, nome, programa, tipo } = req.body || {};
  if (!roomId || !userId || !programa)
    return res.status(400).json({ ok: false, error: "dados incompletos" });

  const room = getRoom(String(roomId));
  if (!room.participacao) room.participacao = {};

  const key = String(userId);
  if (!room.participacao[key]) {
    room.participacao[key] = { tgId: key, nome: String(nome || "Anon"), programa: String(programa), tipo: tipo || "", mensagens: 0 };
  }
  room.participacao[key].mensagens += 1;
  room.participacao[key].nome = String(nome || room.participacao[key].nome);

  // recalcula porcentagens
  const items = Object.values(room.participacao);
  const total = items.reduce((s, i) => s + i.mensagens, 0);
  items.forEach((i) => { i.porcentagem = total > 0 ? Math.round((i.mensagens / total) * 100) + "%" : "0%"; });

  const ranking = items.sort((a, b) => b.mensagens - a.mensagens);
  res.json({ ok: true, ranking });
});

/**
 * GET /participacao/:roomId
 * Retorna ranking atual da sala.
 */
app.get("/participacao/:roomId", (req, res) => {
  const roomId = String(req.params.roomId || "").trim();
  const room = rooms[roomId];
  if (!room || !room.participacao) return res.json({ ok: true, ranking: [] });
  const items = Object.values(room.participacao).sort((a, b) => b.mensagens - a.mensagens);
  res.json({ ok: true, ranking: items });
});

/**
 * GET /export/:roomId?clear=true
 * Exporta histórico (Apps Script chama no fim da transmissão).
 */
app.get("/export/:roomId", (req, res) => {
  const roomId = String(req.params.roomId || "");
  const room = rooms[roomId];
  const messages = room ? room.messages : [];
  const participacao = room ? (room.participacao ? Object.values(room.participacao) : []) : [];
  if (String(req.query.clear) === "true") delete rooms[roomId];
  res.json({ roomId, messages, participacao, cleared: String(req.query.clear) === "true" });
});

// ─── WebSocket (opcional — melhora a experiência mas não é obrigatório) ───────
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === "join") {
      const roomId = String(msg.roomId || "").trim();
      const userId = String(msg.userId || "").trim();
      const nome   = String(msg.nome   || "Anon").trim();
      if (!roomId || !userId) return wsSend(ws, { type: "error", message: "roomId e userId obrigatórios" });

      const room = getRoom(roomId);
      ws.roomId = roomId;
      ws.userId = userId;
      ws.nome   = nome;
      room.clients.add(ws);

      const history = room.messages;
      const recent = history.length > 200 ? history.slice(-200) : history;
      wsSend(ws, { type: "history", messages: recent });
      return;
    }

    if (msg.type === "message") {
      const roomId = String(msg.roomId || ws.roomId || "").trim();
      const userId = String(msg.userId || ws.userId || "").trim();
      const nome   = String(msg.nome   || ws.nome   || "Anon").trim();
      const texto  = String(msg.texto  || "").trim();
      const gifUrl = msg.gifUrl || "";
      if (!roomId || !userId || (!texto && !gifUrl))
        return wsSend(ws, { type: "error", message: "dados incompletos" });

      const chatMsg = {
        id: genId(), tgId: userId, nome,
        texto, tipo: msg.tipo || "texto", gifUrl,
        data: new Date().toISOString(),
      };

      const room = pushMessage(roomId, chatMsg);

      // registra participação automaticamente
      if (!room.participacao) room.participacao = {};
      if (!room.participacao[userId]) room.participacao[userId] = { tgId: userId, nome, programa: roomId, tipo: "", mensagens: 0 };
      room.participacao[userId].mensagens += 1;
      const items = Object.values(room.participacao);
      const total = items.reduce((s, i) => s + i.mensagens, 0);
      items.forEach((i) => { i.porcentagem = Math.round((i.mensagens / total) * 100) + "%"; });

      // broadcast para OUTROS clientes WS
      broadcast(room, { type: "message", message: chatMsg }, ws);
      // ACK para o remetente com id real
      wsSend(ws, { type: "message_ack", message: chatMsg });
      return;
    }
  });

  ws.on("close", () => {
    if (ws.roomId && rooms[ws.roomId]) rooms[ws.roomId].clients.delete(ws);
  });
});

server.listen(PORT, () => console.log("Chat backend rodando na porta", PORT));
