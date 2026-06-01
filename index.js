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

    if (item.title || item.embedDesc) {
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

app.get("/", (req, res) => {
  res.redirect("/panel.html");
});

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


// ── SEND RULES ──
app.post("/api/send-rules", requirePanelAuth, async (req, res) => {
  const { channelId } = req.body;
  if (!channelId) return res.status(400).json({ error: "channelId required" });
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return res.status(404).json({ error: "ไม่พบห้อง" });

  const C = {
    header: 0x23272A, green: 0x57F287, yellow: 0xFEE75C, red: 0xED4245,
    blue: 0x5865F2, purple: 0x9B59B6, cyan: 0x00B0F4, pink: 0xEB459E,
    orange: 0xE67E22, gray: 0x747F8D,
  };

  const rules = [
    { color: C.header, description: ["## 📜  กฎระเบียบและข้อบังคับในการอยู่ร่วมกัน", "", "ขอความร่วมมือสมาชิกทุกคนเคารพซึ่งกันและกัน เพื่อให้คอมมูนิตี้นี้เป็นพื้นที่ที่น่าอยู่ ปลอดภัย และเป็นระเบียบเรียบร้อยสำหรับทุกคนครับ/ค่ะ", "", "-# 📊 **ระดับโทษ (เพิ่มขึ้นตามลำดับ)**", "-# ตักเตือน  →  Mute  →  Kick  →  **Ban ถาวร**"].join("\n") },
    { color: C.green, title: "🤝  ๑ · มารยาทและการเคารพสิทธิ์  (Respect & Privacy)", fields: [{ name: "💬  การสนทนาทั่วไป", value: "ให้เกียรติและเคารพผู้อื่นทุกคน พูดคุยด้วยความสุภาพและเป็นมิตร ไม่ใช้คำหยาบหรือคำรุนแรง\n> 🔸 ตักเตือน → Mute → Kick → Ban ถาวร" }, { name: "🫧  การเว้นระยะห่าง", value: "ไม่ล้ำเส้นความเป็นส่วนตัวของผู้ที่ไม่สนิทสนม การหยอกล้อต้องได้รับความยินยอมจากทั้งสองฝ่าย\n> 🔸 ตักเตือน → Mute → Ban *(หากดักเตือนแล้วไม่หยุด)*" }, { name: "⚖️  ห้ามละเมิดสิทธิ์และเสรีภาพ", value: "ห้ามข่มขู่ บังคับ ควบคุม หรือจำกัดเสรีภาพในการใช้งานคอมมูนิตี้ของสมาชิกท่านอื่นด้วยวิธีใดก็ตาม ทุกคนมีสิทธิ์เท่าเทียมกันภายใต้กฎของเซิร์ฟ\n> 🔸 Mute → Kick → Ban ถาวร" }] },
    { color: C.yellow, title: "🔇  ๒ · ห้ามก่อกวนและสร้างความวุ่นวาย  (Anti-Griefing)", fields: [{ name: "📵  สแปม", value: "ห้ามส่งข้อความ อีโมจิ รูปภาพ หรือสติกเกอร์รัวๆ จนรบกวนการสนทนา\n> 🔸 Mute ทันที → ซ้ำ → Kick + Ban ถาวร" }, { name: "📣  การแท็ก", value: "ห้ามแท็กสมาชิกท่านอื่น หรือแท็ก @everyone / @here โดยไม่มีเหตุจำเป็น\n> 🔸 ตักเตือน → Mute → Ban *(เจตนาป่วนเซิร์ฟ → Ban ทันที)*" }, { name: "😤  พฤติกรรม Toxic", value: "ห้ามแซะ ประชดประชัน ดันหลัง หรือเหน็บแนม (Passive-Aggressive) ซ้ำๆ จนทำลายบรรยากาศโดยรวม แม้จะไม่ใช้คำหยาบก็ตาม\n> 🔸 Mute → Kick → Ban ถาวรทันที" }, { name: "🔊  มารยาทในห้องเสียง / วิดีโอ", value: "ห้ามเปิดไมค์เสียงดัง เป่าไมค์ หรือส่งเสียงก่อกวน รวมถึงห้ามสแปม Soundboard และ **ห้ามแอบอัดคลิป บันทึกหน้าจอ หรือแอบถ่ายผู้อื่น** ขณะเปิดกล้องหรือสตรีมโดยที่เจ้าตัวไม่ยินยอม\n> 🔸 Mute ในห้องเสียง → แบนจากห้องเสียง → Ban ออกจากเซิร์ฟถาวร" }] },
    { color: C.red, title: "🔞  ๓ · ความปลอดภัยจากสิ่งอนาจารและการคุกคาม  (NSFW & Harassment)", fields: [{ name: "🚨  การคุกคามทางเพศ (Sexual Harassment)", value: "ห้ามคุกคามทางเพศทุกรูปแบบ ทั้งคำพูด ข้อความ และรูปภาพ\n> 🔴 **Ban ถาวรทันที ไม่มีข้อยกเว้น**" }, { name: "🚫  สื่อลามกอนาจาร (NSFW / Gore)", value: "ห้ามแชร์สื่อลามก ภาพโป๊เปลือย สิ่งล่อแหลม (NSFW) หรือภาพสยดสยอง (Gore) ทุกชนิดในห้องแชททั่วไป\n> 🔸 ลบโพสต์ → Kick → Ban ถาวรทันที" }, { name: "📺  การสตรีมจอ (Share Screen)", value: "ขณะเปิดกล้อง/แชร์หน้าจอ ห้ามเปิดสื่อผิดกฎหมาย สิ่งอนาจาร หรือเปิดเผยข้อมูลส่วนตัวของผู้อื่น\n> 🔸 ปิดสตรีมทันที → ดึงสายออก → Ban ถาวรทันที" }, { name: "😣  ความสบายใจของสมาชิก", value: "ห้ามส่งสิ่งที่ทำให้อีกฝ่ายรู้สึกอึดอัด หากอีกฝ่ายแจ้งว่าไม่ยินยอมถือว่าผิดกฎทันที\n> 🔸 ตักเตือน → Mute → Kick → Ban ถาวร" }] },
    { color: C.blue, title: "⚖️  ๔ · การจัดการข้อพิพาทและหลักฐาน  (Conflict & Evidence)", fields: [{ name: "🙅  ห้ามทะเลาะในพื้นที่สาธารณะ", value: "หากมีปัญหากัน ให้พูดคุยในพื้นที่ส่วนตัว ห้ามทะเลาะในแชทสาธารณะ\n> 🔸 ลบข้อความ → Mute คู่กรณี → Ban ทั้งคู่ *(ถ้าสร้างดราม่าต่อ)*" }, { name: "🎟️  ไม่สามารถเคลียร์กันเองได้", value: "กรุณาเปิด Ticket หรือทักทีมงานทันที ห้ามสร้างความเสียหายหรือโจมตีกันในทุกกรณี\n> 🔸 Mute → Kick → Ban ถาวร" }, { name: "📢  การรายงานผู้กระทำผิด", value: "ให้กด Report หรือแจ้งทีมงาน **ห้ามดราม่าหรือตอบโต้กลับเอง** มิฉะนั้นจะโดนโทษร่วม\n> 🔸 ตักเตือน → Mute → Ban" }, { name: "🛑  ห้ามปลอมแปลงหลักฐาน", value: "ห้ามตัดต่อ แก้ไข หรือบิดเบือนข้อความ/ภาพแชท เพื่อแจ้งความเท็จหรือใส่ร้ายผู้อื่น\n> 🔴 **Ban ถาวรทันที**" }] },
    { color: C.purple, title: "🔒  ๕ · ความปลอดภัย ข้อมูลส่วนบุคคล และ DM  (Privacy & DM)", fields: [{ name: "🚫  Strictly No DoXXing", value: "ห้ามขุดคุ้ย ประจาน หรือเปิดเผยข้อมูลส่วนตัวของผู้อื่น (ชื่อจริง รูปถ่าย ที่อยู่ เบอร์โทรฯ โซเชียลส่วนตัว ฯลฯ) โดยไม่ได้รับอนุญาต\n> 🔴 **Ban ถาวรทันที ไม่มีการตักเตือน**" }, { name: "🕵️  ข้อยกเว้นสำหรับทีมงาน", value: "ในกรณีที่มีผู้กระทำผิดหรือทุจริต ทีมงานมีสิทธิ์นำหลักฐาน (ภาพแชท, ชื่อ Discord, Discord ID) มาโพสต์ชี้แจงเพื่อความโปร่งใส โดยจะ Censor ข้อมูลในโลกจริงบางส่วนตามความเหมาะสม" }, { name: "📷  การรักษาความลับในคอมมู", value: "ห้ามแคปข้อความ รูปภาพ หรือเรื่องราวภายในเซิร์ฟนี้ไปโพสต์โจมตีหรือสร้างดราม่าในแพลตฟอร์มอื่น (X, Facebook, TikTok ฯลฯ)\n> 🔴 **Ban ถาวรทันที ไม่มีการเจรจา**" }, { name: "📩  ห้ามก่อกวนทาง DM", value: "ห้ามใช้ DM ทักไปจีบเชิงคุกคาม ข่มขู่ ก่อกวน หรือส่งโฆษณา/ชวนเข้าเซิร์ฟอื่นโดยที่อีกฝ่ายไม่ยินยอม\n> 🔸 Kick → Ban ถาวร" }] },
    { color: C.pink, title: "🌈  ๖ · ห้ามเหยียดและประเด็นอ่อนไหว  (Anti-Discrimination)", fields: [{ name: "🚫  Anti-Discrimination", value: "ห้ามเหยียดเพศ รูปร่าง สัญชาติ ศาสนา ความเชื่อ หรือความสามารถของผู้อื่น *(ยกเว้นหยอกเล่นในกลุ่มที่ทุกฝ่ายยินยอม 100%)*\n> 🔸 Mute → Kick → **Ban ถาวรทันที**" }, { name: "🤐  ประเด็นอ่อนไหว (Sensitive Topics)", value: "ห้ามพูดคุย ถกเถียง หรือแชร์เนื้อหาเกี่ยวกับ **การเมือง สถาบันฯ ศาสนา** ในเชิงยุยง ปลุกปั่น หรือก่อให้เกิดความแตกแยก\n> 🔸 ตักเตือน → ลบข้อความ → Mute → Ban ถาวร" }] },
    { color: C.red, title: "🔗  ๗ · ห้ามส่งลิงก์อันตราย  (Malicious Links)", fields: [{ name: "☣️  Phishing / มัลแวร์ / เว็บพนัน", value: "ห้ามส่งลิงก์ฟิชชิ่ง มัลแวร์ ไวรัส เว็บพนัน หรือเว็บไซต์อันตรายทุกชนิดที่ส่งผลต่อความปลอดภัยของสมาชิก\n> 🔴 ลบลิงก์อัตโนมัติ → **Ban ถาวรทันที**" }] },
    { color: C.orange, title: "🛡️  ๘ · ห้ามโจมตีเซิร์ฟเวอร์  (Cyber Security & Anti-Raid)", fields: [{ name: "💣  DDoS / Nuke / Token Grabbing / Raid", value: "ห้ามทุกอย่างที่มีเจตนาทำลายหรือโจมตีเซิร์ฟเวอร์ ได้แก่:\n- นำบอทป่วนเข้ามา\n- ชักชวนคนมารุมถล่ม (Raid)\n- พยายามเจาะระบบหรือส่งเครื่องมือโจมตี\n- พูดคุย แจกจ่าย หรือขโมย Token (Token Grabbing)\n- ลบห้อง/ยศเพื่อทำลายเซิร์ฟ (Nuke) แม้จะขู่เล่นก็ตาม\n> 🔴 **Ban ถาวรทันที + ขึ้นบัญชีดำทุกเครือข่าย ไม่มีข้อยกเว้น**" }, { name: "💥  ห้ามทำให้ระบบค้าง", value: "ห้ามส่ง Crash Text หรือใช้วิธีใดๆ ที่ส่งผลกระทบต่อประสิทธิภาพการทำงานของเซิร์ฟเวอร์\n> 🔴 **Ban ถาวรทันที**" }] },
    { color: C.cyan, title: "⚙️  ๙ · การใช้งานระบบและห้องแชท  (Channels & Bots)", fields: [{ name: "🤖  ใช้บอทให้ถูกที่", value: "ใช้งานและส่งคำสั่งบอทในห้องที่กำหนดเท่านั้น ห้ามจงใจก่อกวนผู้อื่นผ่านบอท\n> 🔸 ตักเตือน → Mute → Ban ถาวร" }, { name: "🏠  ใช้ห้องแชทให้ตรงวัตถุประสงค์", value: "โพสต์/พูดคุยให้ตรงกับประเภทของห้อง ห้ามคอมเมนต์นอกเรื่อง (Off-topic) ในกระทู้หรือห้องเฉพาะทาง\n> 🔸 ลบโพสต์ → ตักเตือน → Mute + Ban *(ถ้าทำผิดห้องซ้ำ)*" }] },
    { color: C.blue, title: "👤  ๑๐ · การแสดงตนและอัตลักษณ์  (Profile & Identity)", fields: [{ name: "🎭  ห้ามแอบอ้างตัวตน", value: "ห้ามปลอมตัวเป็นทีมงานหรือสมาชิกคนอื่น ไม่ว่าจะตั้งใจหรือเล่นมุกก็ตาม\n> 🔸 ตักเตือนให้เปลี่ยน → Kick → Ban *(หากแอบอ้างไปหลอกลวงผู้อื่น)*" }, { name: "🖼️  ความเหมาะสมของโปรไฟล์", value: "ห้ามใช้ชื่อ รูปโปรไฟล์ Status หรือแบนเนอร์ที่ไม่เหมาะสม ลามก หยาบคาย หรือสร้างความไม่สบายใจ\n> 🔸 ตักเตือน → เตะออกให้ระบบรีเซ็ต → Ban ถาวร" }, { name: "🤖  ผลงาน AI (AI-Generated)", value: "ห้ามนำผลงาน AI มาอ้างว่าเป็นงานวาดหรือสร้างสรรค์ของตนเอง หากต้องการแชร์ให้โพสต์ในห้องที่กำหนดพร้อมติดป้ายให้ชัดเจน\n> 🔸 ลบผลงาน → ดักเตือน → Mute → Ban *(ถ้านำ AI มาหลอกขาย)*" }] },
    { color: C.yellow, title: "🛒  ๑๑ · การประชาสัมพันธ์และการซื้อขาย  (Marketplace & Promotion)", fields: [{ name: "✅  สิ่งที่ทำได้", value: "- โปรโมทร้านคอมมิชชัน, TikTok, YouTube, ลิงก์สตรีมไลฟ์ **ในห้องที่จัดไว้เท่านั้น**\n- ซื้อขายผ่านช่องทางทีมงาน *(ตรวจสอบยศผู้ขายทุกครั้งเพื่อป้องกันมิจฉาชีพแอบอ้าง)*" }, { name: "❌  สิ่งที่ห้ามทำ  —  โทษ: ลบข้อความ → Kick → Ban ถาวรทันที", value: "- ห้ามโปรโมทลิงก์เชิญ Discord หรือคอมมูนิตี้อื่น **โดยไม่ได้รับอนุญาต**\n- ห้ามสแปมโฆษณา/โปรโมทซ้ำ รวมถึง DM โปรโมทส่วนตัวกับสมาชิก\n- ห้ามสมาชิกทั่วไปโพสต์ขายสินค้า เปิดพรีออเดอร์ หรือทำธุรกรรมการเงินโดยไม่ได้รับอนุญาต\n- ห้ามซื้อขายสิ่งผิดกฎหมาย หรือบริการที่ละเมิด ToS ของ Discord (ไอดีเกม, Cheats, RMT ฯลฯ)" }] },
    { color: C.gray, title: "📌  ๑๒ · บทลงโทษและการดำเนินงาน  (Enforcement & Rules)", fields: [{ name: "👤  ความรับผิดชอบต่อบัญชีของตนเอง", value: "สมาชิกทุกคนต้องรับผิดชอบต่อทุกการกระทำที่เกิดขึ้นจากบัญชี Discord ของตนเอง ทีมงานจะ**ไม่รับฟัง**ข้ออ้าง เช่น \"โดนแฮก\", \"น้องเล่น\" หรือ \"เพื่อนยืมไอดี\" ทุกกรณี" }, { name: "🕳️  ห้ามใช้ช่องโหว่ของกฎ (Loophole)", value: "ห้ามเจตนาตีความเพื่อหาช่องว่างหรือโต้แย้งการทำงานของทีมงานในเชิงก่อกวน พฤติกรรมดังกล่าวจะถูกลงโทษเช่นเดียวกับการกระทำผิดในข้อนั้น หรือรุนแรงกว่าตามดุลยพินิจ" }, { name: "🔨  คำตัดสินของทีมงาน", value: "ทีมงานขอสงวนสิทธิ์ในการขยับโทษเป็น **\"Ban ถาวร\"** ได้ทันทีโดยไม่ต้องแจ้งล่วงหน้า หากพิจารณาแล้วว่าการกระทำนั้นส่งผลกระทบร้ายแรงต่อส่วนรวม **คำตัดสินของทีมงานในทุกกรณีถือเป็นที่สิ้นสุด**" }], footer: { text: "📋 Revolve Community — Rules & Guidelines  •  @everyone" } },
  ];

  try {
    // ลบข้อความเก่า (ภายใน 14 วัน) ก่อนส่งใหม่
    try {
      const old = await channel.messages.fetch({ limit: 100 });
      const deletable = old.filter(m => Date.now() - m.createdTimestamp < 14 * 86400000);
      if (deletable.size > 1) await channel.bulkDelete(deletable);
      else if (deletable.size === 1) await deletable.first().delete();
    } catch { /* ข้าม ถ้าลบไม่ได้ */ }

    for (const rule of rules) {
      const e = new EmbedBuilder().setColor(rule.color);
      if (rule.title)       e.setTitle(rule.title);
      if (rule.description) e.setDescription(rule.description);
      if (rule.fields)      e.addFields(rule.fields);
      if (rule.footer)      e.setFooter(rule.footer);
      await channel.send({ embeds: [e] });
      await new Promise(r => setTimeout(r, 500));
    }
    res.json({ ok: true, count: rules.length });
  } catch (err) {
    console.error("[send-rules]", err);
    res.status(500).json({ error: err.message });
  }
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
