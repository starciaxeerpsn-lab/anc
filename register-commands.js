// register-commands.js — รัน node register-commands.js ครั้งเดียวเพื่อ register slash commands
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("announce")
    .setDescription("ส่งประกาศไปยัง channel ที่กำหนด")
    .addChannelOption(o => o.setName("channel").setDescription("channel ปลายทาง").setRequired(true))
    .addStringOption(o => o.setName("message").setDescription("ข้อความประกาศ").setRequired(false))
    .addAttachmentOption(o => o.setName("image").setDescription("รูปภาพ").setRequired(false))
    .addAttachmentOption(o => o.setName("file").setDescription("ไฟล์แนบ").setRequired(false))
    .addStringOption(o => o.setName("title").setDescription("หัวข้อ embed").setRequired(false))
    .addStringOption(o => o.setName("color").setDescription("สี embed เช่น #ff2d95").setRequired(false))
    .addStringOption(o => o.setName("schedule").setDescription("กำหนดเวลา เช่น 2024-12-25 18:00 (เวลาไทย)").setRequired(false))
    .addStringOption(o => o.setName("mention").setDescription("mention เช่น @everyone, @here, หรือ role ID").setRequired(false)),

  new SlashCommandBuilder()
    .setName("announce-panel")
    .setDescription("เปิด Web Panel สำหรับสร้างประกาศ"),

  new SlashCommandBuilder()
    .setName("announce-list")
    .setDescription("ดูรายการประกาศที่กำหนดเวลาไว้"),

  new SlashCommandBuilder()
    .setName("announce-cancel")
    .setDescription("ยกเลิกประกาศที่กำหนดเวลาไว้")
    .addStringOption(o => o.setName("id").setDescription("ID ของประกาศ").setRequired(true)),
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN || require("./config").DISCORD_TOKEN);

(async () => {
  try {
    console.log("📡 Registering slash commands...");
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID || require("./config").CLIENT_ID),
      { body: commands }
    );
    console.log("✅ Commands registered!");
  } catch (err) {
    console.error("❌ Error:", err);
  }
})();
