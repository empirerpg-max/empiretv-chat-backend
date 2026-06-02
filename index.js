// ============================================================
// EMPIRE TV — Chat Backend v3
// WebSocket-first (zero delay) + HTTP fallback
// Arquivo: salvo via POST /room/close → Apps Script grava na planilha
// ============================================================
const express   = require("express");
const cors      = require("cors");
const http      = require("http");
const WebSocket = require("ws");

const app  = express();
const PORT = process.env.PORT || 10000;

// URL do Apps Script para persistência — sete via variável de ambiente
const GAS_ARCHIVE_URL = process.env.GAS_ARCHIVE_URL || "";

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));

// ─── Memória ──────────────────────────────────────────────────────────────────
// rooms[roomId] = { messages[], clients Set, participacao{}, meta{} }
// archive[roomId] = snapshot (em RAM até restart; persistência real fica na planilha)
const rooms   = {};
const archive = {};

function getRoom(id) {
  if (!rooms[id]) rooms[id] = { messages: [], clients: new Set(), participacao: {}, meta: {} };
  return rooms[id];
}
function genId() {
  return "m_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}
function wsSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function broadcastRoom(room, payload, exclude) {
  room.clients.forEach(c => { if (c !== exclude) wsSend(c, payload); });
}
function pushMsg(roomId, msg) {
  const r = getRoom(roomId);
  r.messages.push(msg);
  if (r.messages.length > 5000) r.messages = r.messages.slice(-5000);
  return r;
}
function addParticipacao(room, userId, nome, roomId) {
  if (!room.participacao[userId])
    room.participacao[userId] = { tgId: userId, nome, programa: roomId, mensagens: 0 };
  room.participacao[userId].mensagens++;
  room.participacao[userId].nome = nome;
  const items = Object.values(room.participacao);
  const total = items.reduce((s, i) => s + i.mensagens, 0);
  items.forEach(i => { i.porcentagem = total ? Math.round(i.mensagens / total * 100) + "%" : "0%"; });
}
function ranking(room) {
  return Object.values(room.participacao || {}).sort((a, b) => b.mensagens - a.mensagens);
}
function broadcastOnline(room) {
  const count = room.clients.size;
  room.clients.forEach(c => wsSend(c, { type: "online", count }));
}

// ─── Healthcheck ─────────────────────────────────────────────────────────────
app.get("/ping", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ─── Online count ─────────────────────────────────────────────────────────────
app.get("/online/:roomId", (req, res) => {
  const r = rooms[req.params.roomId];
  res.json({ ok: true, count: r ? r.clients.size : 0 });
});

// ─── Mensagens (HTTP fallback) ────────────────────────────────────────────────
app.get("/messages/:roomId", (req, res) => {
  const id = String(req.params.roomId || "").trim();
  if (!id) return res.status(400).json({ ok: false, error: "roomId obrigatório" });
  if (archive[id]) {
    const ar = archive[id];
    return res.json({ ok: true, archived: true, messages: ar.messages.slice(-200),
      meta: ar.meta, ranking: ranking(ar), closedAt: ar.closedAt });
  }
  const room  = getRoom(id);
  const since = req.query.since ? +new Date(req.query.since) : 0;
  const msgs  = since > 0
    ? room.messages.filter(m => +new Date(m.data) > since)
    : room.messages.slice(-100);
  res.json({ ok: true, archived: false, messages: msgs, onlineCount: room.clients.size, ts: new Date().toISOString() });
});

// ─── Enviar mensagem (HTTP fallback) ─────────────────────────────────────────
app.post("/send", (req, res) => {
  const { roomId, userId, nome, texto, tipo, gifUrl } = req.body || {};
  if (!roomId || !userId || (!texto && !gifUrl))
    return res.status(400).json({ ok: false, error: "dados incompletos" });
  if (archive[roomId])
    return res.status(403).json({ ok: false, error: "Transmissão encerrada." });
  const msg = { id: genId(), tgId: String(userId), nome: String(nome || "Anon"),
    texto: String(texto || ""), tipo: tipo || "texto", gifUrl: gifUrl || "",
    data: new Date().toISOString() };
  const room = pushMsg(String(roomId), msg);
  addParticipacao(room, String(userId), String(nome || "Anon"), String(roomId));
  broadcastRoom(room, { type: "message", message: msg });
  broadcastOnline(room);
  res.json({ ok: true, message: msg });
});

// ─── Metadados da sala ────────────────────────────────────────────────────────
app.post("/room/meta", (req, res) => {
  const { roomId, programa, tipo, data, horario, capaUrl } = req.body || {};
  if (!roomId) return res.status(400).json({ ok: false, error: "roomId obrigatório" });
  const r = getRoom(String(roomId));
  r.meta = { programa: programa || "", tipo: tipo || "", data: data || "", horario: horario || "", capaUrl: capaUrl || "" };
  res.json({ ok: true });
});

// ─── Encerrar transmissão → arquivar + notificar GAS ─────────────────────────
app.post("/room/close", async (req, res) => {
  const { roomId, secret } = req.body || {};
  if (!roomId) return res.status(400).json({ ok: false, error: "roomId obrigatório" });
  if (process.env.WORKER_SECRET && secret !== process.env.WORKER_SECRET)
    return res.status(401).json({ ok: false, error: "unauthorized" });

  const room = rooms[String(roomId)];
  if (!room) return res.json({ ok: true, message: "sala já inexistente" });

  const snapshot = {
    messages:     [...room.messages],
    participacao: { ...room.participacao },
    meta:         room.meta || {},
    closedAt:     new Date().toISOString(),
  };
  archive[String(roomId)] = snapshot;

  // Notifica clientes WS
  room.clients.forEach(c => {
    wsSend(c, { type: "room_closed", roomId, closedAt: snapshot.closedAt });
    setTimeout(() => c.close(), 1500);
  });
  delete rooms[String(roomId)];

  // Persiste na planilha via GAS (fire-and-forget)
  if (GAS_ARCHIVE_URL) {
    const payload = {
      acao:         "tv_archive_save",
      roomId:       String(roomId),
      programa:     snapshot.meta.programa || roomId,
      tipo:         snapshot.meta.tipo || "",
      data:         snapshot.meta.data || "",
      horario:      snapshot.meta.horario || "",
      capaUrl:      snapshot.meta.capaUrl || "",
      closedAt:     snapshot.closedAt,
      totalMsgs:    snapshot.messages.length,
      totalUsers:   Object.keys(snapshot.participacao).length,
      messagesJson: JSON.stringify(snapshot.messages),
      rankingJson:  JSON.stringify(ranking(snapshot)),
    };
    fetch(GAS_ARCHIVE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(e => console.error("[archive] GAS error:", e.message));
  }

  res.json({ ok: true, snapshot });
});

// ─── Arquivo em RAM (lista) ───────────────────────────────────────────────────
app.get("/archive", (_req, res) => {
  const list = Object.entries(archive).map(([roomId, ar]) => ({
    roomId, programa: ar.meta.programa || roomId, tipo: ar.meta.tipo || "",
    data: ar.meta.data || "", horario: ar.meta.horario || "", capaUrl: ar.meta.capaUrl || "",
    closedAt: ar.closedAt, totalMsgs: ar.messages.length,
    totalUsers: Object.keys(ar.participacao || {}).length,
  })).sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt));
  res.json({ ok: true, archive: list });
});

app.get("/archive/:roomId", (req, res) => {
  const ar = archive[String(req.params.roomId)];
  if (!ar) return res.status(404).json({ ok: false, error: "Arquivo não encontrado" });
  res.json({ ok: true, roomId: req.params.roomId, ...ar, ranking: ranking(ar) });
});

// ─── Participação ─────────────────────────────────────────────────────────────
app.get("/participacao/:roomId", (req, res) => {
  const id   = String(req.params.roomId || "").trim();
  const room = rooms[id] || archive[id];
  if (!room) return res.json({ ok: true, ranking: [] });
  res.json({ ok: true, ranking: ranking(room) });
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url    = new URL(req.url, "http://x");
  const roomId = url.searchParams.get("roomId") || "";
  const userId = url.searchParams.get("userId") || "u_" + genId();
  const nome   = decodeURIComponent(url.searchParams.get("nome") || "Anon");

  if (!roomId) { ws.close(1008, "roomId obrigatório"); return; }

  // Sala já arquivada → manda histórico e fecha
  if (archive[roomId]) {
    wsSend(ws, { type: "history", messages: archive[roomId].messages.slice(-200),
      archived: true, closedAt: archive[roomId].closedAt });
    ws.close(); return;
  }

  const room = getRoom(roomId);
  ws.roomId  = roomId;
  ws.userId  = userId;
  ws.nome    = nome;
  room.clients.add(ws);

  // Histórico imediato
  wsSend(ws, { type: "history",
    messages: room.messages.length > 200 ? room.messages.slice(-200) : room.messages,
    archived: false });
  broadcastOnline(room);

  // Keepalive ping a cada 25s
  const pingInterval = setInterval(() => wsSend(ws, { type: "ping" }), 25000);

  ws.on("message", raw => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "pong") return;

    if (msg.type === "message") {
      const texto  = String(msg.texto || "").trim().slice(0, 500);
      const gifUrl = msg.gifUrl || "";
      if (!texto && !gifUrl) return;
      if (archive[ws.roomId]) { wsSend(ws, { type: "error", message: "Transmissão encerrada." }); return; }

      const chatMsg = { id: genId(), tgId: ws.userId, nome: ws.nome,
        texto, tipo: msg.tipo || "texto", gifUrl, data: new Date().toISOString() };

      const r = pushMsg(ws.roomId, chatMsg);
      addParticipacao(r, ws.userId, ws.nome, ws.roomId);

      wsSend(ws, { type: "message", message: chatMsg, ack: true });
      broadcastRoom(r, { type: "message", message: chatMsg }, ws);
    }
  });

  ws.on("close", () => {
    clearInterval(pingInterval);
    if (ws.roomId && rooms[ws.roomId]) {
      rooms[ws.roomId].clients.delete(ws);
      broadcastOnline(rooms[ws.roomId]);
    }
  });
  ws.on("error", () => {
    clearInterval(pingInterval);
    if (ws.roomId && rooms[ws.roomId]) rooms[ws.roomId].clients.delete(ws);
  });
});

server.listen(PORT, () => console.log("✅ Empire TV Chat v3 na porta", PORT));
