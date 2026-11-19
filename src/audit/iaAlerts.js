// iaAlerts.js
//
// Analyses audit history for each member and fires a recommendation to the
// configured IA channel when a nation has been consistently failing above
// the configured failure rate threshold within the configured window.
//
// Key accuracy safeguards:
//   - Requires a minimum number of audits in the window before recommending.
//     A nation with only 1 or 2 audit records can't be recommended — not
//     enough data to be sure.
//   - Uses a rate (e.g. 75% of audits failing) rather than a raw count, so
//     a nation that improved recently doesn't get flagged.
//   - Per-nation cooldown prevents the same nation being pinged repeatedly
//     while they're being handled by IA.

const { EmbedBuilder } = require("discord.js");
const { repairDailyAuditRecords } = require("./dailyAudit");
const { saveSettings } = require("../db");
const { queryPNW } = require("../pnw");

// A failing audit is one graded "Failing" (the lowest grade). Records from before
// grades existed only have a pass/fail value, so that is used for those.
function isFailing(record) {
  if (typeof record.grade === "string" && record.grade.trim()) {
    return record.grade.trim().toLowerCase() === "failing";
  }
  return record.pass === false;
}

function getWindowStart(windowDays) {
  return new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
}

function isOnCooldown(settings, nationId) {
  const lastAlerted = settings.iaAlerts.lastAlertedNations?.[String(nationId)];
  if (!lastAlerted) return false;
  const cooldownMs = settings.iaAlerts.cooldownDays * 24 * 60 * 60 * 1000;
  return Date.now() - new Date(lastAlerted).getTime() < cooldownMs;
}

function analyseNation(nationId, nationName, auditHistory, settings) {
  const config = settings.iaAlerts;
  const windowStart = getWindowStart(config.windowDays);

  // Only look at audits within the configured window
  const recentAudits = auditHistory.filter(
    (r) => String(r.nationId) === String(nationId) && new Date(r.date) >= windowStart
  );

  if (recentAudits.length < config.minAudits) {
    return { recommend: false, reason: "insufficient_data", auditCount: recentAudits.length };
  }

  const failingAudits = recentAudits.filter((r) => isFailing(r, settings));
  const failureRate = Math.round((failingAudits.length / recentAudits.length) * 100);

  if (failureRate < config.failureRateThreshold) {
    return { recommend: false, reason: "below_threshold", failureRate, auditCount: recentAudits.length };
  }

  // Build a brief trend summary showing the last 10 results
  const recent10 = recentAudits.slice(-10).map((r) => (isFailing(r, settings) ? "❌" : "✅")).join(" ");
  const scores = recentAudits.map((r) => r.score ?? 0);
  const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const lowestScore = Math.min(...scores);

  return {
    recommend: true,
    failureRate,
    auditCount: recentAudits.length,
    failingCount: failingAudits.length,
    avgScore,
    lowestScore,
    recent10,
    windowDays: config.windowDays
  };
}

// ---------------------------------------------------------------------------
// Inactivity trigger: a nation that has not been active in the game for more
// than `inactivityDays` (default 8) is recommended for removal, separately
// from the audit-failure trigger above. Nations in Vacation Mode are skipped
// (they are away on purpose, and the VM guard deals with long VMs).
// ---------------------------------------------------------------------------

const DAY_MS = 86400000;
const ACTIVITY_QUERY = `
  query AllianceActivity($allianceId: [Int], $page: Int) {
    nations(alliance_id: $allianceId, first: 50, page: $page) {
      paginatorInfo { hasMorePages currentPage }
      data { id nation_name num_cities alliance_position vacation_mode_turns last_active }
    }
  }
`;

async function fetchAllianceActivity(allianceId) {
  const members = [];
  let page = 1;
  let more = true;
  while (more) {
    const data = await queryPNW(ACTIVITY_QUERY, { allianceId: [Number(allianceId)], page });
    const result = data?.nations;
    if (!result) break;
    members.push(...result.data);
    more = result.paginatorInfo?.hasMorePages ?? false;
    page += 1;
  }
  // Applicants aren't members yet.
  return members.filter((n) => (n.alliance_position || "").toUpperCase() !== "APPLICANT");
}

async function runInactivityRecommendations(channel, settings, stats, ignoreCooldown = false) {
  const config = settings.iaAlerts;
  const days = config.inactivityDays ?? 8;
  const now = Date.now();
  const cooldownMs = (config.cooldownDays ?? 7) * DAY_MS;
  if (!config.lastAlertedNations) config.lastAlertedNations = {};

  const members = await fetchAllianceActivity(settings.alliance.id);
  stats.inactiveChecked = members.length;

  const flagged = [];
  for (const nation of members) {
    const lastActive = new Date(nation.last_active).getTime();
    if (!nation.last_active || Number.isNaN(lastActive)) {
      stats.inactiveNoData += 1;
      continue;
    }
    const inactiveDays = (now - lastActive) / DAY_MS;
    if (inactiveDays <= days) continue;
    stats.inactiveOverLimit += 1;
    if (Number(nation.vacation_mode_turns) > 0) {
      stats.inactiveVmSkipped += 1; // away on purpose
      continue;
    }

    // A separate key from the audit-failure alerts, so one doesn't hide the other.
    const key = `${nation.id}:inactive`;
    const alertedAt = config.lastAlertedNations[key];
    if (!ignoreCooldown && alertedAt && now - new Date(alertedAt).getTime() < cooldownMs) {
      stats.inactiveOnCooldown += 1;
      continue;
    }
    flagged.push({ nation, inactiveDays, lastActive, key });
  }
  if (flagged.length === 0) return;

  flagged.sort((a, b) => b.inactiveDays - a.inactiveDays); // most inactive first

  const lines = flagged.map(
    ({ nation, inactiveDays, lastActive }) =>
      `• [${nation.nation_name}](https://politicsandwar.com/nation/id=${nation.id}) · C${nation.num_cities} — ` +
      `inactive **${Math.floor(inactiveDays)} days** (last active <t:${Math.floor(lastActive / 1000)}:R>)`
  );

  // Group into messages that stay well under Discord's size limits.
  const batches = [];
  let current = [];
  let length = 0;
  flagged.forEach((item, index) => {
    if (current.length > 0 && length + lines[index].length + 1 > 3500) {
      batches.push(current);
      current = [];
      length = 0;
    }
    current.push({ item, line: lines[index] });
    length += lines[index].length + 1;
  });
  if (current.length > 0) batches.push(current);

  let first = true;
  for (const batch of batches) {
    const embed = new EmbedBuilder()
      .setTitle(first ? "💤 IA Removal Recommendation — inactive nations" : "💤 IA Removal Recommendation — inactive nations (cont.)")
      .setColor(0xe67e22)
      .setDescription(
        (first
          ? `**${flagged.length}** nation(s) have been inactive for more than **${days} days** (Vacation Mode excluded). Removal is recommended.\n\n`
          : "") + batch.map((b) => b.line).join("\n")
      )
      .setFooter({ text: `Threshold: ${days} days of inactivity. Change it with /set_ia_config inactivity_days.` });

    try {
      await channel.send(
        first
          ? { content: `<@&${config.iaRoleId}>`, embeds: [embed], allowedMentions: { roles: [config.iaRoleId] } }
          : { embeds: [embed] }
      );
      first = false;
      for (const { item } of batch) config.lastAlertedNations[item.key] = new Date().toISOString();
      stats.inactiveRecommended += batch.length;
    } catch (error) {
      stats.errors += 1;
      console.error(`[iaAlerts] Couldn't post the inactivity recommendation:`, error.message);
      break;
    }
  }
}

async function runIaAlertsForGuild(client, guild, settings, guildId, { ignoreCooldown = false } = {}) {
  const config = settings.iaAlerts;
  const stats = {
    checked: 0,
    recommended: 0,
    skippedCooldown: 0,
    skippedData: 0,
    inactiveChecked: 0,
    inactiveOverLimit: 0,
    inactiveVmSkipped: 0,
    inactiveOnCooldown: 0,
    inactiveNoData: 0,
    inactiveRecommended: 0,
    repaired: 0,
    errors: 0,
    problem: null
  };

  if (!config.iaChannelId || !config.iaRoleId) {
    stats.problem = "The IA role or channel isn't set - use /set_ia_config.";
    return stats;
  }

  const channel = guild.channels.cache.get(config.iaChannelId);
  if (!channel) {
    stats.problem = "The IA channel can't be found - it may have been deleted, or the bot can't see it.";
    return stats;
  }

  // Daily-audit records saved by an earlier version have no grade; fix them from their saved score.
  try {
    stats.repaired = repairDailyAuditRecords(settings);
  } catch (error) {
    console.error("[iaAlerts] Couldn't repair old audit records:", error.message);
  }

  // ---- Trigger 1: nations failing audits for too long ----
  // Kept separate so that a problem here can never stop the inactivity trigger below.
  try {
    const windowStart = getWindowStart(config.windowDays);
    const recentHistory = (settings.auditHistory || []).filter((r) => r && new Date(r.date) >= windowStart);

    const nationMap = new Map();
    for (const record of recentHistory) {
      if (!nationMap.has(String(record.nationId))) {
        nationMap.set(String(record.nationId), record.nationName);
      }
    }

    stats.checked = nationMap.size;

    for (const [nationId, nationName] of nationMap.entries()) {
      if (!ignoreCooldown && isOnCooldown(settings, nationId)) {
        stats.skippedCooldown += 1;
        continue;
      }

      const analysis = analyseNation(nationId, nationName, (settings.auditHistory || []).filter(Boolean), settings);

      if (!analysis.recommend) {
        if (analysis.reason === "insufficient_data") stats.skippedData += 1;
        continue;
      }

      const embed = new EmbedBuilder()
        .setTitle(`🚨 IA Removal Recommendation — ${nationName}`)
        .setColor(0xe74c3c)
        .setDescription(
          `**Nation:** ${nationName} (ID: ${nationId})\n` +
            `**Failure rate:** ${analysis.failureRate}% (${analysis.failingCount}/${analysis.auditCount} audits failing)\n` +
            `**Window:** Last ${analysis.windowDays} days\n` +
            `**Average score:** ${analysis.avgScore}% | **Lowest:** ${analysis.lowestScore}%\n\n` +
            `**Recent trend (oldest → newest):**\n${analysis.recent10}\n\n` +
            `This nation has been consistently failing audit standards. IA review is recommended.\n` +
            `View full history with \`/audit_history nation:${nationId}\``
        )
        .setFooter({
          text: `Threshold: ${config.failureRateThreshold}% failure rate over ${config.windowDays} days (min ${config.minAudits} audits required)`
        });

      try {
        await channel.send({
          content: `<@&${config.iaRoleId}>`,
          embeds: [embed],
          allowedMentions: { roles: [config.iaRoleId] }
        });
        stats.recommended += 1;

        // Mark this nation as alerted so we don't ping again during the cooldown
        if (!settings.iaAlerts.lastAlertedNations) settings.iaAlerts.lastAlertedNations = {};
        settings.iaAlerts.lastAlertedNations[String(nationId)] = new Date().toISOString();
      } catch (error) {
        stats.errors += 1;
        console.error(`[iaAlerts] Failed to post alert for nation ${nationId}:`, error.message);
      }
    }
  } catch (error) {
    stats.errors += 1;
    console.error("[iaAlerts] Audit-failure analysis failed:", error);
  }

  // ---- Trigger 2: nations inactive for too long (on by default) ----
  if (config.inactivityEnabled !== false && settings.alliance?.id) {
    try {
      await runInactivityRecommendations(channel, settings, stats, ignoreCooldown);
    } catch (error) {
      stats.errors += 1;
      console.error("[iaAlerts] Inactivity check failed:", error.message);
    }
  }

  saveSettings(guildId, settings);
  return stats;
}

module.exports = { runIaAlertsForGuild };
