# 📣 Announce Bot

Discord บอทสำหรับส่งประกาศ พร้อม Web Panel สวยงาม

## ✨ Features

- **Slash Commands** — `/announce`, `/announce-panel`, `/announce-list`, `/announce-cancel`
- **Web Panel** — UI สำหรับสร้างประกาศแบบ Embed หรือข้อความธรรมดา
- **แนบไฟล์/รูปภาพ** — ลากวางได้, รองรับทุกนามสกุล, สูงสุด 25MB/ไฟล์
- **กำหนดเวลา (Schedule)** — ส่งประกาศล่วงหน้าตามเวลาไทย (UTC+7)
- **Mention** — @everyone, @here, หรือ Role ที่ต้องการ
- **Embed** — กำหนดสี, หัวข้อ, thumbnail, image URL, footer
- **Redis Persistence** — ตารางเวลาไม่หายแม้บอท restart

---

## 🚀 Setup

### 1. Clone & Install
```bash
git clone <repo>
cd announce-bot
npm install
```

### 2. ตั้งค่า Environment Variables
```bash
cp .env.example .env
# แก้ไข .env ให้ครบ
```

| Variable | คำอธิบาย |
|---|---|
| `DISCORD_TOKEN` | Token จาก [Discord Developer Portal](https://discord.com/developers/applications) |
| `CLIENT_ID` | Application ID ของบอท |
| `OWNER_ID` | Discord User ID ของ owner (ข้าม permission check) |
| `UPSTASH_REDIS_REST_URL` | URL จาก [Upstash Console](https://console.upstash.com) |
| `UPSTASH_REDIS_REST_TOKEN` | Token จาก Upstash |
| `PORT` | Port ของ web server (default: 3000) |
| `BASE_URL` | URL สาธารณะ เช่น `https://mybot.railway.app` |
| `PANEL_SECRET` | ปล่อยว่างให้ generate เอง หรือตั้งเอง |

### 3. Register Slash Commands (ทำครั้งเดียว)
```bash
node register-commands.js
```

### 4. รันบอท
```bash
npm start
# หรือ
node index.js
```

---

## 📋 Slash Commands

| คำสั่ง | คำอธิบาย | สิทธิ์ |
|---|---|---|
| `/announce` | ส่งประกาศผ่าน Discord โดยตรง | Manage Guild |
| `/announce-panel` | รับลิงก์ Web Panel (ephemeral) | Manage Guild |
| `/announce-list` | ดูประกาศที่กำหนดเวลาไว้ | Manage Guild |
| `/announce-cancel [id]` | ยกเลิกประกาศที่กำหนดเวลา | Manage Guild |

---

## 🌐 Web Panel

เข้าถึงได้จาก `/announce-panel` — ลิงก์จะมี `?secret=xxx` ที่ใช้แทน login

### Features ใน Panel
- เลือก Server & Channel
- สร้าง Embed สวยงาม หรือข้อความธรรมดา
- ลากวางไฟล์/รูปภาพ
- Preview ก่อนส่ง
- กำหนดเวลาส่ง
- ดู/ยกเลิกประกาศที่กำหนดเวลา

---

## 🔒 Security

- Web Panel ป้องกันด้วย `PANEL_SECRET` ที่ generate ใหม่ทุก restart (หรือตั้งค่าเองได้)
- ลิงก์ Panel ส่งแบบ ephemeral (มองเห็นเฉพาะผู้ใช้คนนั้น)
- Slash Commands ใช้ได้เฉพาะ admin (Manage Guild) หรือ OWNER_ID

---

## ☁️ Deploy บน Railway / Render / Fly.io

1. Push โค้ดขึ้น GitHub
2. สร้าง project ใหม่บน platform ที่ต้องการ
3. ตั้ง Environment Variables ให้ครบ
4. ตั้ง `BASE_URL` ให้ตรงกับ URL ที่ platform ให้มา
5. `npm start`

---

## 📁 Project Structure

```
announce-bot/
├── index.js              # Main bot + Express server
├── register-commands.js  # Register slash commands (run once)
├── package.json
├── .env.example
├── public/
│   └── panel.html        # Web Panel UI
└── uploads/              # Temp file storage (auto-created)
```
