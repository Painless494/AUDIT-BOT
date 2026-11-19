// dailyAudit.js
//
// Runs a silent Grand Audit on every active alliance member once per day.
// No DMs, no channel posts - just saves results to auditHistory so the
// IA alert system has enough data points to make accurate recommendations.
// The more data points we have, the less likely a nation gets flagged just
// because they happened to fail on the day we checked.

const { getAllianceNations, isActiveMember } = require("../pnw");
const { runGrandAudit } = require("./grandAudit");
const { buildHistoryRecord } = require("./runAudit");
const { getGrade, isPassingGrade } = require("./grading");
const { saveSettings } = require("../db");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// An earlier version of this file saved every daily record without its grade
// (and with a "pass" value that always counted as passing), so /audit_history
// showed those days as Passing no matter what the score was. The score itself
// was saved correctly, so the grade can be worked out again from it.
// Safe to run any number of times: records that are already correct are left alone.
function repairDailyAuditRecords(settings) {
  let repaired = 0;
  for (const record of settings.auditHistory || []) {
    if (!record || record.command !== "daily_audit") continue;
    if (typeof record.pass === "boolean" && typeof record.grade === "string" && record.grade) continue;
    if (typeof record.score !== "number" || Number.isNaN(record.score)) continue;

    const grade = getGrade(record.score, settings.gradeThresholds);
    record.grade = grade.label;
    record.pass = isPassingGrade(grade);
    repaired += 1;
  }
  return repaired;
}

async function runDailyAuditForGuild(settings, guildId) {
  const stats = { checked: 0, saved: 0, errors: 0, repaired: 0 };

  if (!settings.alliance.id) return stats;

  stats.repaired = repairDailyAuditRecords(settings);

  const { members } = await getAllianceNations(settings.alliance.id);
  const activeMembers = members.filter(isActiveMember);
  stats.checked = activeMembers.length;

  for (const nation of activeMembers) {
    try {
      const result = await runGrandAudit(nation, settings);
      const percent = result.percent;
      const grade = getGrade(percent, settings.gradeThresholds);
      const pass = isPassingGrade(grade);

      // Same format as manual audits, so everything reads the history the same way.
      const record = buildHistoryRecord(nation, percent, pass, "daily_audit", grade);

      if (!settings.auditHistory) settings.auditHistory = [];
      settings.auditHistory.push(record);

      // Cap history at 2000 entries to prevent the file growing forever.
      if (settings.auditHistory.length > 2000) {
        settings.auditHistory = settings.auditHistory.slice(-2000);
      }

      stats.saved += 1;
    } catch (error) {
      stats.errors += 1;
      console.error(`[dailyAudit] Error auditing nation ${nation.id} (${nation.nation_name}):`, error.message);
    }

    await sleep(200); // be polite to the PnW API
  }

  saveSettings(guildId, settings);
  return stats;
}

module.exports = { runDailyAuditForGuild, repairDailyAuditRecords };
