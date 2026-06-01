const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const PORT = process.env.PORT || 10000;

// permitir chamadas do seu app (ajuste origin se quiser travar)
app.use(cors());
app.use(express.json());

// --- Estrutura em memória -------------------------------------------------

// rooms[roomId] = { messages: ChatMsg[], clients: Set<WebSocket> }
const rooms = {};

// gera id simples de mensagem
function genId() {
  return "m_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2);
}

// --- HTTP para healthcheck e histórico ------------------------------------

app.get("/ping", (req, res) => {
  res.json({ ok: true, message: "empiretv-chat-backend online" });
});

// pega histórico de uma sala (para fallback ou debug)
app.get("/history/:roomId", (req, res) => {
  const roomId = String(req.params.roomId || "");
  const room = rooms[roomId];
  res.json(room ? room.messages : []);
});

// exporta e opcionalmente limpa sala (para Apps Script usar no fim do programa)
app.get("/export/:roomId", (req, res) => {
  const roomId = String(req.params.roomId || "");
  const room = rooms[roomId];
  const messages = room ? room.messages : [];
  const clear = String(req.query.clear || "false") === "true";
  if (clear) {
    delete rooms[roomId];
  }
  res.json({ roomId, messages, cleared: clear });
});

// --- Servidor HTTP + WebSocket --------------------------------------------

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// helper: envia JSON pelo socket
function wsSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// quando um cliente conecta
wss.on("connection", (ws, req) => {
  // vamos receber os dados de identificação na primeira mensagem
  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // handshake inicial: { type: "join", roomId, userId, nome }
    if (msg.type === "join") {
      const roomId = String(msg.roomId || "").trim();
      const userId = String(msg.userId || "").trim();
      const nome = String(msg.nome || "Anon").trim();

      if (!roomId || !userId) {
        wsSend(ws, { type: "error", message: "roomId e userId obrigatórios" });
        return;
      }

      if (!rooms[roomId]) {
        rooms[roomId] = { messages: [], clients: new Set() };
      }
      ws.roomId = roomId;
      ws.userId = userId;
      ws.nome = nome;
      rooms[roomId].clients.add(ws);

      // manda histórico recente (limitar a, por exemplo, 200 últimas)
      const history = rooms[roomId].messages;
      const recent =
        history.length > 200 ? history.slice(history.length - 200) : history;
      wsSend(ws, { type: "history", messages: recent });

      return;
    }

    // enviar nova mensagem: { type: "message", roomId, userId, nome, texto, tipo, gifUrl }
    if (msg.type === "message") {
      const roomId = String(msg.roomId || ws.roomId || "").trim();
      const userId = String(msg.userId || ws.userId || "").trim();
      const nome = String(msg.nome || ws.nome || "Anon").trim();
      const texto = String(msg.texto || "").trim();
      const tipo = msg.tipo || "texto";
      const gifUrl = msg.gifUrl || "";

      if (!roomId || !userId || (!texto && !gifUrl)) {
        wsSend(ws, { type: "error", message: "dados incompletos" });
        return;
      }

      if (!rooms[roomId]) {
        rooms[roomId] = { messages: [], clients: new Set() };
      }

      const chatMsg = {
        id: genId(),
        tgId: userId,
        nome,
        texto,
        tipo,
        gifUrl,
        data: new Date().toISOString(),
      };

      // guarda em memória (até ~2000 por sala)
      const room = rooms[roomId];
      room.messages.push(chatMsg);
      if (room.messages.length > 2000) {
        room.messages = room.messages.slice(room.messages.length - 2000);
      }

      // FIX: broadcast para todos na sala EXCETO o remetente.
      // O remetente já inseriu uma mensagem otimista localmente (prefixo tmp-).
      // Incluí-lo no broadcast causaria duplicata no frontend.
      room.clients.forEach((client) => {
        if (client !== ws) {
          wsSend(client, { type: "message", message: chatMsg });
        }
      });

      // Confirma para o remetente com o id real gerado pelo servidor,
      // permitindo que o frontend troque a mensagem otimista pela definitiva.
      wsSend(ws, { type: "message_ack", message: chatMsg });

      return;
    }
  });

  ws.on("close", () => {
    const roomId = ws.roomId;
    if (roomId && rooms[roomId]) {
      rooms[roomId].clients.delete(ws);
    }
  });
});

server.listen(PORT, () => {
  console.log("Chat backend rodando na porta", PORT);
});
