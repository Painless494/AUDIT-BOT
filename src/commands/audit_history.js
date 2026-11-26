const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { resolveNationInput } = require("../audit/resolveNationInput");
const { getGrade } = require("../audit/grading");
const { repairDailyAuditRecords } = require("../audit/dailyAudit");
const { getSettings, saveSettings } = require("../db");

const SHOW = 10; // how many days to list

function trendArrow(newer, older) {
  if (older === undefined) return "▫️"; // nothing earlier to compare with
  const change = newer - older;
  if (change > 0.5) return "📈";
  if (change < -0.5) return "📉";
  return "➡️";
}

module.exports = {
  minTier: "member",
  data: new SlashCommandBuilder()
    .setName("audit_history")
    .setDescription("Show a nation's daily audit scores over time, with trend arrows.")
    .addStringOption((opt) =>
      opt.setName("nation").setDescription("Nation ID, name, profile link, or @mention").setRequired(true)
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const settings = getSettings(interaction.guildId);

    let nationId;
    try {
      nationId = String(await resolveNationInput(interaction.client, settings, interaction.options.getString("nation")));
    } catch (error) {
      await interaction.editReply(`❌ ${error.message}`);
      return;
    }

    // Daily records saved by an earlier version had no grade; fix them from their score.
    if (repairDailyAuditRecords(settings) > 0) saveSettings(interaction.guildId, settings);

    // Only the silent daily audits are shown - manual audits (/grand_audit, /my_audit, ...) are not.
    // One entry per day: if the daily audit ran twice on a day, the later one is used.
    const byDay = new Map();
    for (const record of settings.auditHistory || []) {
      if (!record || record.command !== "daily_audit" || String(record.nationId) !== nationId) continue;
      if (typeof record.score !== "number") continue;
      byDay.set(String(record.date), record);
    }
    const days = [...byDay.values()].sort((a, b) => String(b.date).localeCompare(String(a.date))); // newest first

    if (days.length === 0) {
      await interaction.editReply(
        "No daily audit history for that nation yet. The silent daily audit records one result per day for every active member; " +
          "a nation in Vacation Mode isn't recorded."
      );
      return;
    }

    const shown = days.slice(0, SHOW);
    const lines = shown.map((record, index) => {
      const older = days[index + 1];
      const grade = getGrade(record.score, settings.gradeThresholds);
      return `${trendArrow(record.score, older?.score)} **${record.date}** — ${record.score}% — ${grade.emoji} ${grade.label}`;
    });

    const latest = days[0];
    const latestGrade = getGrade(latest.score, settings.gradeThresholds);
    const average = Math.round((shown.reduce((sum, r) => sum + r.score, 0) / shown.length) * 10) / 10;

    const embed = new EmbedBuilder()
      .setTitle(`Daily Audit History — ${latest.nationName}`)
      .setColor(latestGrade.color)
      .setDescription(
        `**Latest:** ${latest.score}% (${latestGrade.emoji} ${latestGrade.label})\n` +
          `**Average of the last ${shown.length} day(s):** ${average}%\n` +
          `**Days on record:** ${days.length}\n\n` +
          lines.join("\n")
      )
      .setFooter({ text: "📈 improving · 📉 getting worse · ➡️ no change. Shows the daily audits only." });

    await interaction.editReply({ embeds: [embed] });
  }
};
