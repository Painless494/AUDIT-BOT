const { SlashCommandBuilder } = require("discord.js");
const { runIaAlertsForGuild } = require("../audit/iaAlerts");
const { getSettings, saveSettings } = require("../db");

module.exports = {
  minTier: "government",
  data: new SlashCommandBuilder()
    .setName("run_ia_check")
    .setDescription("Run the IA recommendation checks now instead of waiting for the daily one.")
    .addBooleanOption((opt) =>
      opt
        .setName("ignore_cooldown")
        .setDescription("Also re-send recommendations that were already sent recently (for testing)")
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const settings = getSettings(interaction.guildId);

    if (!settings.iaAlerts) {
      settings.iaAlerts = {
        enabled: false, windowDays: 28, minAudits: 7,
        failureRateThreshold: 75, iaRoleId: null, iaChannelId: null,
        cooldownDays: 7, lastRunAt: null, lastAlertedNations: {}
      };
    }
    const config = settings.iaAlerts;

    if (!config.iaChannelId || !config.iaRoleId) {
      await interaction.editReply("❌ IA channel or role not configured — run /set_ia_config first.");
      return;
    }

    await interaction.editReply("⏳ Running the IA checks...");

    const ignoreCooldown = interaction.options.getBoolean("ignore_cooldown") ?? false;
    let stats;
    try {
      stats = await runIaAlertsForGuild(interaction.client, interaction.guild, settings, interaction.guildId, { ignoreCooldown });
    } catch (error) {
      await interaction.editReply(`❌ The check failed: ${error.message}`);
      return;
    }

    if (stats.problem) {
      await interaction.editReply(`❌ ${stats.problem}`);
      return;
    }

    config.lastRunAt = new Date().toISOString();
    saveSettings(interaction.guildId, settings);

    const days = config.inactivityDays ?? 8;
    const lines = [
      "✅ **IA check complete.**" + (ignoreCooldown ? " *(cooldown ignored)*" : ""),
      "",
      "**Audit failures**",
      `• Nations with audit history in the last ${config.windowDays} days: **${stats.checked}**`,
      `• Recommendations posted: **${stats.recommended}**`,
      `• Not enough history yet (needs ${config.minAudits} audits in the window): **${stats.skippedData}**`,
      `• Already recommended recently: **${stats.skippedCooldown}**`
    ];

    if (config.inactivityEnabled === false) {
      lines.push("", "**Inactivity:** switched OFF (`/set_ia_config inactivity_alerts:True` to turn it on).");
    } else {
      lines.push(
        "",
        `**Inactivity (more than ${days} days)**`,
        `• Members checked: **${stats.inactiveChecked}**`,
        `• Over the limit: **${stats.inactiveOverLimit}**` +
          (stats.inactiveVmSkipped ? ` (${stats.inactiveVmSkipped} in Vacation Mode, skipped)` : "") +
          (stats.inactiveOnCooldown ? ` (${stats.inactiveOnCooldown} already recommended recently)` : ""),
        `• Recommendations posted: **${stats.inactiveRecommended}**`
      );
    }

    if (stats.repaired > 0) lines.push("", `🔧 Repaired **${stats.repaired}** old daily-audit record(s) that had a wrong grade.`);
    if (stats.errors > 0) lines.push("", `⚠️ ${stats.errors} problem(s) happened - see the Railway log (lines starting with [iaAlerts]).`);

    await interaction.editReply(lines.join("\n"));
  }
};
