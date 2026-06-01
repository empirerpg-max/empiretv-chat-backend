const express = require("express");

const app = express();
const PORT = process.env.PORT || 10000;

app.get("/ping", (req, res) => {
  res.json({ ok: true, message: "empiretv-chat-backend online" });
});

app.listen(PORT, () => {
  console.log("Chat backend rodando na porta", PORT);
});
