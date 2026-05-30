// ── ANNOUNCE BOT — index.js ──
const { Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits, AttachmentBuilder } = require("discord.js");
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Redis } = require("@upstash/redis");

// ── ENV ──
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OWNER_ID = process.env.OWNER_ID || "";
const PORT = process.env.PORT || 3000;

let PANEL_SECRET = process.env.PANEL_SECRET || "";

// ── REDIS ──
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ── DISCORD CLIENT ──
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

// ── UPLOAD DIR ──
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${path.extname(file.originalname)}`),
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

// ── SCHEDULED ANNOUNCEMENTS ──
const SCHEDULE_KEY = "announce:scheduled";
const SECRET_KEY = "announce:panel_secret";
const scheduledTimers = new Map();

async function getScheduled() {
  try {
    const raw = await redis.get(SCHEDULE_KEY);
    if (!raw) return [];
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch { return []; }
}
async function saveScheduled(list) {
  await redis.set(SCHEDULE_KEY, JSON.stringify(list));
}

async function initPanelSecret() {
  if (PANEL_SECRET) return;
  try {
    const saved = await redis.get(SECRET_KEY);
    if (saved) {
      PANEL_SECRET = saved;
    } else {
      PANEL_SECRET = crypto.randomBytes(16).toString("hex");
      await redis.set(SECRET_KEY, PANEL_SECRET);
    }
  } catch {
    PANEL_SECRET = crypto.randomBytes(16).toString("hex");
  }
}

async function scheduleAnnouncement(item) {
  const delay = new Date(item.scheduledAt).getTime() - Date.now();
  if (delay <= 0) {
    await sendAnnouncement(item);
    return;
  }
  const timer = setTimeout(async () => {
    await sendAnnouncement(item);
    const list = await getScheduled();
    await saveScheduled(list.filter(i => i.id !== item.id));
    scheduledTimers.delete(item.id);
  }, delay);
  scheduledTimers.set(item.id, timer);
}

async function sendAnnouncement(item) {
  try {
    const channel = await client.channels.fetch(item.channelId).catch(() => null);
    if (!channel) return console.warn(`[announce] channel ${item.channelId} not found`);

    const files = [];
    const messagePayload = {};

    if (item.mention) messagePayload.content = item.mention;

    if (item.title || item.color || item.embedDesc) {
      const embed = new EmbedBuilder();
      if (item.title) embed.setTitle(item.title);
      if (item.embedDesc) embed.setDescription(item.embedDesc);
      if (item.color) embed.setColor(item.color);
      if (item.footer) embed.setFooter({ text: item.footer });
      if (item.imageUrl) embed.setImage(item.imageUrl);
      if (item.thumbnailUrl) embed.setThumbnail(item.thumbnailUrl);
      embed.setTimestamp();
      messagePayload.embeds = [embed];
    } else if (item.message) {
      messagePayload.content = (messagePayload.content ? messagePayload.content + "\n" : "") + item.message;
    }

    if (item.attachments && item.attachments.length > 0) {
      for (const att of item.attachments) {
        const filePath = path.join(uploadsDir, att.filename);
        if (fs.existsSync(filePath)) {
          files.push(new AttachmentBuilder(filePath, { name: att.originalname || att.filename }));
        }
      }
      if (files.length > 0) messagePayload.files = files;
    }

    await channel.send(messagePayload);
    console.log(`[announce] sent to #${channel.name}`);
  } catch (err) {
    console.error("[announce] send error:", err);
  }
}

async function loadScheduledOnBoot() {
  const list = await getScheduled();
  const now = Date.now();
  const future = list.filter(i => new Date(i.scheduledAt).getTime() > now);
  if (future.length !== list.length) await saveScheduled(future);
  for (const item of future) await scheduleAnnouncement(item);
  console.log(`[announce] loaded ${future.length} scheduled announcements`);
}

// ── EXPRESS APP ──
const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(uploadsDir));

function requirePanelAuth(req, res, next) {
  const secret = req.headers["x-panel-secret"] || req.query.secret;
  if (secret !== PANEL_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
}

app.get("/api/guilds", requirePanelAuth, (req, res) => {
  const guilds = client.guilds.cache.map(g => ({ id: g.id, name: g.name }));
  res.json(guilds);
});

app.get("/api/channels/:guildId", requirePanelAuth, (req, res) => {
  const guild = client.guilds.cache.get(req.params.guildId);
  if (!guild) return res.status(404).json({ error: "Guild not found" });
  const channels = guild.channels.cache
    .filter(c => [0, 5, 10, 11, 12, 15, 16].includes(c.type))
    .map(c => ({
      id: c.id,
      name: c.name,
      category: c.parent?.name || "—",
      type: c.type,
    }))
    .sort((a, b) => {
      const catA = a.category || "";
      const catB = b.category || "";
      if (catA !== catB) return catA.localeCompare(catB);
      return a.name.localeCompare(b.name);
    });
  res.json(channels);
});

app.get("/api/roles/:guildId", requirePanelAuth, (req, res) => {
  const guild = client.guilds.cache.get(req.params.guildId);
  if (!guild) return res.status(404).json({ error: "Guild not found" });
  const roles = guild.roles.cache
    .filter(r => r.name !== "@everyone")
    .map(r => ({ id: r.id, name: r.name, color: r.hexColor }))
    .sort((a, b) => b.position - a.position);
  res.json(roles);
});

app.post("/api/upload", requirePanelAuth, upload.array("files", 10), (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: "No files" });
  const result = req.files.map(f => ({
    filename: f.filename,
    originalname: f.originalname,
    size: f.size,
    mimetype: f.mimetype,
    url: `/uploads/${f.filename}`,
  }));
  res.json({ ok: true, files: result });
});

app.post("/api/announce", requirePanelAuth, async (req, res) => {
  const { channelId, message, title, embedDesc, color, footer, imageUrl, thumbnailUrl, mention, attachments, scheduledAt } = req.body;
  if (!channelId) return res.status(400).json({ error: "channelId required" });

  const item = {
    id: crypto.randomBytes(6).toString("hex"),
    channelId, message, title, embedDesc, color, footer,
    imageUrl, thumbnailUrl, mention, attachments: attachments || [],
    scheduledAt: scheduledAt || null,
    createdAt: new Date().toISOString(),
  };

  if (scheduledAt && new Date(scheduledAt).getTime() > Date.now()) {
    const list = await getScheduled();
    list.push(item);
    await saveScheduled(list);
    await scheduleAnnouncement(item);
    return res.json({ ok: true, scheduled: true, id: item.id, scheduledAt });
  }

  await sendAnnouncement(item);
  res.json({ ok: true, scheduled: false, id: item.id });
});

app.get("/api/scheduled", requirePanelAuth, async (req, res) => {
  const list = await getScheduled();
  res.json(list);
});

app.delete("/api/scheduled/:id", requirePanelAuth, async (req, res) => {
  const { id } = req.params;
  const timer = scheduledTimers.get(id);
  if (timer) { clearTimeout(timer); scheduledTimers.delete(id); }
  const list = await getScheduled();
  const newList = list.filter(i => i.id !== id);
  await saveScheduled(newList);
  res.json({ ok: true, deleted: list.length !== newList.length });
});

app.get("/api/status", (req, res) => {
  res.json({ online: client.isReady(), tag: client.user?.tag || "Offline" });
});

// ── DISCORD SLASH COMMANDS ──
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) && interaction.user.id !== OWNER_ID) {
    return interaction.reply({ content: "❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้", ephemeral: true });
  }

  if (commandName === "announce-panel") {
    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
    const url = `${baseUrl}/panel.html?secret=${PANEL_SECRET}`;
    return interaction.reply({
      content: `🖥️ **Announce Panel**\n${url}\n\n⚠️ ลิงก์นี้ใช้ได้เฉพาะคุณ อย่าแชร์ให้คนอื่น`,
      ephemeral: true,
    });
  }

  if (commandName === "announce-list") {
    const list = await getScheduled();
    if (!list.length) return interaction.reply({ content: "📭 ไม่มีประกาศที่กำหนดเวลาไว้", ephemeral: true });
    const lines = list.map(i => {
      const d = new Date(i.scheduledAt);
      return `• \`${i.id}\` — <#${i.channelId}> — <t:${Math.floor(d.getTime()/1000)}:F>`;
    });
    return interaction.reply({ content: `📅 **ประกาศที่กำหนดเวลา:**\n${lines.join("\n")}`, ephemeral: true });
  }

  if (commandName === "announce-cancel") {
    const id = interaction.options.getString("id");
    const timer = scheduledTimers.get(id);
    if (timer) { clearTimeout(timer); scheduledTimers.delete(id); }
    const list = await getScheduled();
    const newList = list.filter(i => i.id !== id);
    await saveScheduled(newList);
    const deleted = list.length !== newList.length;
    return interaction.reply({
      content: deleted ? `✅ ยกเลิกประกาศ \`${id}\` แล้ว` : `❌ ไม่พบประกาศ \`${id}\``,
      ephemeral: true,
    });
  }

  if (commandName === "announce") {
    await interaction.deferReply({ ephemeral: true });
    const channel = interaction.options.getChannel("channel");
    const message = interaction.options.getString("message") || "";
    const title = interaction.options.getString("title") || "";
    const color = interaction.options.getString("color") || "#5865f2";
    const scheduleStr = interaction.options.getString("schedule") || "";
    const mention = interaction.options.getString("mention") || "";
    const imageAtt = interaction.options.getAttachment("image");
    const fileAtt = interaction.options.getAttachment("file");

    const attachments = [];
    if (imageAtt || fileAtt) {
      const fetch = (await import("node-fetch")).default;
      for (const att of [imageAtt, fileAtt].filter(Boolean)) {
        const resp = await fetch(att.url);
        const buf = await resp.buffer();
        const filename = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${path.extname(att.name)}`;
        fs.writeFileSync(path.join(uploadsDir, filename), buf);
        attachments.push({ filename, originalname: att.name, mimetype: att.contentType });
      }
    }

    let scheduledAt = null;
    if (scheduleStr) {
      const d = new Date(scheduleStr + " +07:00");
      if (!isNaN(d)) scheduledAt = d.toISOString();
    }

    const item = {
      id: crypto.randomBytes(6).toString("hex"),
      channelId: channel.id,
      message, title, embedDesc: message, color, mention,
      attachments, scheduledAt,
      createdAt: new Date().toISOString(),
    };

    if (scheduledAt && new Date(scheduledAt).getTime() > Date.now()) {
      const list = await getScheduled();
      list.push(item);
      await saveScheduled(list);
      await scheduleAnnouncement(item);
      const d = new Date(scheduledAt);
      return interaction.editReply({ content: `✅ กำหนดประกาศไว้แล้ว <t:${Math.floor(d.getTime()/1000)}:F>\nID: \`${item.id}\`` });
    }

    await sendAnnouncement(item);
    interaction.editReply({ content: `✅ ส่งประกาศไปยัง <#${channel.id}> แล้ว` });
  }
});

// ── START ──
client.once("ready", async () => {
  console.log(`✅ Announce Bot ready: ${client.user.tag}`);
  await initPanelSecret();
  await loadScheduledOnBoot();
  console.log(`🔑 Panel secret: ${PANEL_SECRET}`);
});

// ── KEEP ALIVE (prevent Render free tier spin down) ──
const https = require("https");
setInterval(() => {
  const url = process.env.BASE_URL;
  if (!url) return;
  https.get(url + "/api/status", (res) => {
    console.log(`[keepalive] ping ${res.statusCode}`);
  }).on("error", () => {});
}, 10 * 60 * 1000); // ทุก 10 นาที

client.login(DISCORD_TOKEN);

app.listen(PORT, () => {
  console.log(`🌐 Panel running on port ${PORT}`);
});
