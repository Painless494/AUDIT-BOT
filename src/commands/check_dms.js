const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { getMemberTier, meetsTier } = require("../permissions");
const { ALL_CHECKS } = require("../audit/grandAudit");
const { loadCheckDms, updateCheckDms: update, enabledKeys } = require("../audit/checkDmStore");
const { buildPlan, buildDmMessages, sendPlan } = require("../audit/checkDms");

// One choice per audit rule, built from the real rules so a new rule shows up
// here automatically. (Discord allows at most 25 choices.)
const CHECK_CHOICES = ALL_CHECKS.slice(0, 25).map((check) => {
  const number = (check.key.match(/^check(\d+)_/) || [])[1];
  return { name: `${number ? number + " - " : ""}${check.label}`.slice(0, 100), value: check.key };
});

// Rules the older automatic reminders (/set_auto_notify) already cover.
const OVERLAPS = new Set(["check12_colour_bloc", "check13_raid_requirement", "check16_activity", "check19_map_usage"]);

function labelFor(key) {
  return CHECK_CHOICES.find((c) => c.value === key)?.name ?? key;
}

function onOff(value) {
  return value ? "🟢 ON" : "🔴 OFF";
}

function settingsText(state) {
  return (
    `**Master switch:** ${onOff(state.enabled)}\n` +
    `**Runs every:** ${state.intervalHours} hour(s)\n` +
    `**Same member + same rule at most every:** ${state.cooldownHours} hour(s)\n` +
    `**Most members messaged per run:** ${state.maxPerRun}`
  );
}

module.exports = {
  minTier: "government",
  data: new SlashCommandBuilder()
    .setName("check_dms")
    .setDescription("Have the bot DM members to explain and fix failing audit rules.")
    .addSubcommand((sub) =>
      sub
        .setName("toggle")
        .setDescription("Switch DM reminders on or off for one audit rule.")
        .addStringOption((opt) => {
          opt.setName("check").setDescription("Which audit rule").setRequired(true);
          for (const choice of CHECK_CHOICES) opt.addChoices(choice);
          return opt;
        })
        .addBooleanOption((opt) => opt.setName("enabled").setDescription("True = send reminders for this rule").setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName("settings")
        .setDescription("Master switch, how often it runs, and limits on how many DMs go out.")
        .addBooleanOption((opt) => opt.setName("master").setDescription("The master switch. Nothing is sent while this is off"))
        .addIntegerOption((opt) => opt.setName("interval_hours").setDescription("How often the automatic check runs, e.g. 12").setMinValue(1))
        .addIntegerOption((opt) =>
          opt.setName("cooldown_hours").setDescription("Minimum hours before the same member is reminded about the same rule, e.g. 48").setMinValue(1)
        )
        .addIntegerOption((opt) =>
          opt.setName("max_per_run").setDescription("Most members messaged in one run, e.g. 25").setMinValue(1).setMaxValue(100)
        )
    )
    .addSubcommand((sub) => sub.setName("status").setDescription("Show which audit rules have DM reminders on, and the settings."))
    .addSubcommand((sub) =>
      sub
        .setName("send")
        .setDescription("Preview or send the reminders now instead of waiting for the next run.")
        .addBooleanOption((opt) =>
          opt.setName("confirm").setDescription("False = only show who would be messaged. True = actually send").setRequired(true)
        )
        .addStringOption((opt) => {
          opt.setName("check").setDescription("Only this rule (works even if its switch is off)");
          for (const choice of CHECK_CHOICES) opt.addChoices(choice);
          return opt;
        })
        .addBooleanOption((opt) => opt.setName("ignore_cooldown").setDescription("Also message members who were reminded recently"))
    ),

  async execute(interaction, settings) {
    await interaction.deferReply();
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if ((sub === "toggle" || sub === "settings") && !meetsTier(getMemberTier(interaction.member, settings), "administrator")) {
      await interaction.editReply("🚫 Only administrators can change these settings.");
      return;
    }

    if (sub === "toggle") {
      const key = interaction.options.getString("check");
      const enabled = interaction.options.getBoolean("enabled");
      const state = update(guildId, (s) => {
        s.checks[key] = enabled;
        return JSON.parse(JSON.stringify(s));
      });

      const notes = [];
      if (enabled && !state.enabled) notes.push("⚠️ The master switch is OFF, so nothing will be sent yet. Turn it on with `/check_dms settings master:True`.");
      if (enabled && OVERLAPS.has(key)) {
        notes.push("ℹ️ The older automatic reminders (`/set_auto_notify`) can already message members about this. Members could get both, so you may want to use just one.");
      }
      if (enabled) notes.push("Tip: run `/check_dms send confirm:False` first to see who would be messaged and what they would read.");

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("DM Reminders Updated")
            .setColor(enabled ? 0x2ecc71 : 0xe74c3c)
            .setDescription(`**${labelFor(key)}**: ${onOff(enabled)}\n\n${notes.join("\n")}`.trim())
        ]
      });
      return;
    }

    if (sub === "settings") {
      const master = interaction.options.getBoolean("master");
      const interval = interaction.options.getInteger("interval_hours");
      const cooldown = interaction.options.getInteger("cooldown_hours");
      const maxPerRun = interaction.options.getInteger("max_per_run");

      const state = update(guildId, (s) => {
        if (master !== null) s.enabled = master;
        if (interval !== null) s.intervalHours = interval;
        if (cooldown !== null) s.cooldownHours = cooldown;
        if (maxPerRun !== null) s.maxPerRun = maxPerRun;
        return JSON.parse(JSON.stringify(s));
      });

      const on = enabledKeys(state);
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("DM Reminder Settings Updated")
            .setColor(state.enabled ? 0x2ecc71 : 0xe74c3c)
            .setDescription(
              `${settingsText(state)}\n\n**Rules switched on:** ${on.length}` +
                (state.enabled && on.length === 0 ? "\n⚠️ No rules are switched on yet - use `/check_dms toggle`." : "")
            )
        ]
      });
      return;
    }

    if (sub === "status") {
      const state = loadCheckDms(guildId);
      const lines = CHECK_CHOICES.map((c) => `${state.checks[c.value] ? "🟢" : "🔴"} ${c.name}`);
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("📬 DM Reminders — Status")
            .setColor(0x3498db)
            .setDescription(
              `${settingsText(state)}\n` +
                `*Vacation Mode members, members without a linked Discord, and tiers excluded with /set_auto_notify_tier are skipped.*\n` +
                `*Last run: ${state.lastRunAt ? `<t:${Math.floor(new Date(state.lastRunAt).getTime() / 1000)}:R>` : "never"}*\n\n` +
                lines.join("\n")
            )
        ]
      });
      return;
    }

    // ---- send (preview or real) ----
    if (!settings.alliance.id) {
      await interaction.editReply("❌ No alliance registered yet — run /set_alliance first.");
      return;
    }
    const confirm = interaction.options.getBoolean("confirm");
    const onlyKey = interaction.options.getString("check");
    const ignoreCooldown = interaction.options.getBoolean("ignore_cooldown") ?? false;
    const state = loadCheckDms(guildId);
    const keys = onlyKey ? [onlyKey] : enabledKeys(state);
    if (keys.length === 0) {
      await interaction.editReply("❌ No audit rules have DM reminders switched on. Use `/check_dms toggle` first, or pick one with the `check` option.");
      return;
    }

    await interaction.editReply("⏳ Checking everyone against the selected rules...");
    let plan;
    try {
      plan = await buildPlan(interaction.client, interaction.guild, settings, state, { keys, ignoreCooldown });
    } catch (error) {
      await interaction.editReply(`❌ Couldn't run the check: ${error.message}`);
      return;
    }
    const s = plan.stats;

    const summary =
      `**${s.members}** active member(s) checked · **${s.planned}** would be messaged` +
      (s.capped ? ` · **${s.capped}** more are waiting for the next run (limit ${state.maxPerRun} per run)` : "") +
      (s.noDiscord ? ` · ${s.noDiscord} skipped (no Discord linked)` : "") +
      (s.onCooldown ? ` · ${s.onCooldown} problem(s) skipped (reminded recently)` : "") +
      (s.skippedVm ? ` · ${s.skippedVm} in Vacation Mode skipped` : "") +
      (s.skippedTier ? ` · ${s.skippedTier} in excluded tiers skipped` : "");

    if (!confirm) {
      const perRule = keys.map((k) => `• ${labelFor(k)}: **${plan.perCheck[k] ?? 0}** member(s)`).join("\n");
      const names = plan.entries.slice(0, 15).map((e) => e.nation.nation_name).join(", ");
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Preview — DM reminders (nothing was sent)")
            .setColor(0xf1c40f)
            .setDescription(
              `${summary}\n\n${perRule}\n\n` +
                (plan.entries.length ? `**First members:** ${names}${plan.entries.length > 15 ? ", ..." : ""}\n\n` : "") +
                "Re-run with `confirm: True` to send these."
            )
        ]
      });
      if (plan.entries.length > 0) {
        const entry = plan.entries[0];
        const sample = buildDmMessages(entry.nation, entry.items, state)[0];
        await interaction.followUp({ content: `**Sample — this is what ${entry.nation.nation_name} would receive:**`, embeds: [sample.embed] });
      }
      return;
    }

    if (plan.entries.length === 0) {
      await interaction.editReply(`Nothing to send right now.\n${summary}`);
      return;
    }
    await interaction.editReply(`⏳ Sending **${plan.entries.length}** message(s)...`);
    const result = await sendPlan(plan, state, interaction.guildId);
    update(guildId, (st) => {
      st.lastRunAt = new Date().toISOString();
    });
    await interaction.editReply(
      `✅ Sent **${result.sent}** message(s)` +
        (result.failed ? `, ${result.failed} couldn't be delivered (their DMs from this server are probably off)` : "") +
        `.\n${summary}`
    );
  }
};
