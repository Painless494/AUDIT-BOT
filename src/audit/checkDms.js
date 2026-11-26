// checkDms.js
//
// Per-rule DM reminders. For every audit rule an administrator has switched
// on, the bot messages each member who is failing that rule and explains, in
// plain language, what is wrong and what to do - so staff don't have to go
// through the list member by member.
//
// Safeguards: nothing is sent unless the master switch AND that rule's switch
// are on; a member is messaged about the same rule at most once per cooldown;
// one DM covers everything that is due for that member; Vacation Mode members
// and tiers excluded with /set_auto_notify_tier are skipped; and at most
// `maxPerRun` members are messaged per run.

const { EmbedBuilder } = require("discord.js");
const { ALL_CHECKS } = require("./grandAudit");
const { getAllianceNations, isActiveMember } = require("../pnw");
const { resolveDiscordUser } = require("./resolveDiscordUser");
const { tierKeyFor } = require("./tiers");
const { loadCheckDms, updateCheckDms, pruneNotes, enabledKeys } = require("./checkDmStore");

const MAX_BULLETS = 6;
const MAX_MESSAGE_LENGTH = 3500; // each DM embed stays well under Discord's limits

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// The words. Each rule gets a plain title and a one-sentence reason; the
// specifics come from what the audit found, and the "what to do" comes from
// the rule's own recommendation.
// ---------------------------------------------------------------------------

const PLAIN = {
  check1_infra_cap: {
    title: "Infrastructure is above the limit",
    why: "TUN sets a maximum infrastructure per city for each nation size, and some of your cities are over it."
  },
  check2_equal_infra: {
    title: "Infrastructure isn't the same in every city",
    why: "TUN wants every city in your nation to have the same amount of infrastructure."
  },
  check3_land_ratio: {
    title: "Land is outside the allowed range",
    why: "Each city's land should be within a set range compared with its infrastructure - not too little and not too much."
  },
  check4_mmr: {
    title: "Military buildings are below the requirement",
    why: "Every city should have exactly 5 hangars, plus enough military buildings in total for your nation size."
  },
  check5_free_slots: {
    title: "You have empty building slots",
    why: "Every city should use all of its building slots."
  },
  check6_farm_restriction: {
    title: "You have farms you're not allowed to have",
    why: "Farms are only allowed with the Green Technologies, Mass Irrigation and Recycling Initiative projects."
  },
  check7_activity_center: {
    title: "The Activity Center project is missing",
    why: "Nations under 21 cities are expected to have the Activity Center project."
  },
  check8_civil_arable: {
    title: "A required project is missing",
    why: "Nations with 10 to 20 cities are expected to have the Center for Civil Engineering and Arable Land Agency projects."
  },
  check9_nuclear_power: {
    title: "Some cities have no nuclear power plant",
    why: "Every city should have a nuclear power plant."
  },
  check10_excess_nuclear: {
    title: "Some cities have too many nuclear plants",
    why: "A city should only have one nuclear power plant."
  },
  check11_project_opportunity: {
    title: "You have an unused project slot",
    why: "Your nation has a free project slot, and TUN expects the guaranteed project slots to be filled."
  },
  check12_colour_bloc: {
    title: "Your nation is on the wrong colour",
    why: "Members are expected to be on the alliance's trade bloc colour."
  },
  check13_raid_requirement: {
    title: "You don't have enough offensive wars",
    why: "Smaller nations are expected to keep a minimum number of offensive wars going."
  },
  check14_resource_control: {
    title: "Your warchest is outside the allowed range",
    why: "TUN sets a maximum and a minimum amount of each resource members should hold."
  },
  check16_activity: {
    title: "You've been inactive",
    why: "Members are expected to log in to the game regularly."
  },
  check17_power_upkeep: {
    title: "Unpowered cities or not enough money for upkeep",
    why: "Your cities should be powered, and you should hold enough money to cover a day of military upkeep."
  },
  check18_military_fill: {
    title: "Your military isn't fully trained",
    why: "Your military should be filled up to what your buildings allow."
  },
  check19_map_usage: {
    title: "Military Action Points are sitting unused",
    why: "MAP shouldn't sit at the cap while you have an active offensive war."
  },
  check20_spy_count: {
    title: "Your spies are below the cap",
    why: "Members are expected to keep their spies full by buying spies every day."
  }
};

function fmt(n) {
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function titleCase(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// Turns the audit's "a; b; c" detail line into a short bullet list.
function bulletsFrom(detail) {
  const parts = String(detail || "").split("; ").map((p) => p.trim()).filter(Boolean);
  const shown = parts.slice(0, MAX_BULLETS).map((p) => `• ${p.length > 180 ? p.slice(0, 177) + "..." : p}`);
  if (parts.length > MAX_BULLETS) shown.push(`• …and ${parts.length - MAX_BULLETS} more`);
  return shown;
}

// One explained problem, as text.
function buildSection(check, result, number) {
  const plain = PLAIN[check.key] || { title: check.label, why: "" };

  // Resource control knows the exact amounts, so it can say how much to deposit.
  if (check.key === "check14_resource_control" && result.data && (result.data.excess.length || result.data.low.length)) {
    const { excess, low } = result.data;
    const title = excess.length && low.length ? plain.title : excess.length ? "You're holding too many resources" : "Your warchest is too low";
    const lines = [`**${number}. ${title}**`];
    if (excess.length) {
      lines.push("You're holding more than the alliance limit. Please deposit the extra into the alliance bank:");
      for (const e of excess) {
        lines.push(`• ${titleCase(e.resource)}: you have ${fmt(e.actual)}, the limit is ${fmt(e.max)} → deposit about **${fmt(e.actual - e.max)}**`);
      }
    }
    if (low.length) {
      lines.push(excess.length ? "" : undefined, "You're holding much less than the minimum warchest. Please build these back up:");
      for (const l of low) {
        lines.push(`• ${titleCase(l.resource)}: you have ${fmt(l.actual)}, the minimum is ${fmt(l.min)} → you need about **${fmt(l.min - l.actual)}** more`);
      }
    }
    return lines.filter((l) => l !== undefined).join("\n");
  }

  const lines = [`**${number}. ${plain.title}**`];
  if (plain.why) lines.push(plain.why);
  lines.push("Here's what the audit found:", ...bulletsFrom(result.detail));
  lines.push(`👉 **What to do:** ${check.recommendation}`);
  return lines.join("\n");
}

// The DM(s) for one member: a greeting, then each problem. Long ones are split
// over several messages so none is too big; each message remembers which
// problems it covers.
function buildDmMessages(nation, items, state) {
  const greeting =
    `Hi ${nation.leader_name || "there"}, this is an automatic note from the TUN audit bot, sent for Internal Affairs. ` +
    `Your nation **${nation.nation_name}** needs attention on ${items.length === 1 ? "1 thing" : `${items.length} things`}:`;

  const groups = [];
  let current = { items: [], texts: [], length: greeting.length };
  items.forEach((item, index) => {
    const text = buildSection(item.check, item.result, index + 1);
    if (current.items.length > 0 && current.length + text.length + 2 > MAX_MESSAGE_LENGTH) {
      groups.push(current);
      current = { items: [], texts: [], length: 0 };
    }
    current.items.push(item);
    current.texts.push(text);
    current.length += text.length + 2;
  });
  if (current.items.length > 0) groups.push(current);

  const hours = state.cooldownHours;
  const footer = `After you fix it, run /my_audit in the TUN server to check. If it's still not fixed you may get a reminder in about ${hours} hours.`;

  return groups.map((group, index) => ({
    items: group.items,
    embed: new EmbedBuilder()
      .setTitle(index === 0 ? `📋 Audit notice — ${nation.nation_name}` : `📋 Audit notice — ${nation.nation_name} (cont.)`)
      .setColor(0xe67e22)
      .setDescription((index === 0 ? `${greeting}\n\n` : "") + group.texts.join("\n\n"))
      .setFooter({ text: footer })
  }));
}

// ---------------------------------------------------------------------------
// Working out who should be messaged
// ---------------------------------------------------------------------------

async function buildPlan(client, guild, settings, state, { keys, ignoreCooldown = false, resolveUsers = true, now = Date.now() }) {
  const stats = {
    members: 0,
    skippedVm: 0,
    skippedTier: 0,
    failingPairs: 0,
    onCooldown: 0,
    noDiscord: 0,
    planned: 0,
    capped: 0
  };
  const perCheck = Object.fromEntries(keys.map((key) => [key, 0]));
  const checks = keys.map((key) => ALL_CHECKS.find((c) => c.key === key)).filter(Boolean);

  const { members: allMembers } = await getAllianceNations(settings.alliance.id);
  const members = allMembers.filter(isActiveMember);
  stats.skippedVm = allMembers.length - members.length;
  stats.members = members.length;

  const excludedTiers = new Set(settings.autoNotify?.excludedTiers || []);
  const cooldownMs = state.cooldownHours * 3600000;

  const due = [];
  for (const nation of members) {
    if (excludedTiers.has(tierKeyFor(nation.num_cities))) {
      stats.skippedTier += 1;
      continue;
    }
    const items = [];
    for (const check of checks) {
      let result;
      try {
        result = check.run(nation, settings);
      } catch (error) {
        continue; // one odd nation shouldn't stop the run
      }
      if (result.passed) continue;
      stats.failingPairs += 1;
      const last = state.lastNotified[`${nation.id}:${check.key}`];
      if (!ignoreCooldown && last && now - new Date(last).getTime() < cooldownMs) {
        stats.onCooldown += 1;
        continue;
      }
      items.push({ check, result });
    }
    if (items.length > 0) due.push({ nation, items });
  }

  // Find each member's Discord account, up to the per-run limit.
  const entries = [];
  for (const entry of due) {
    if (stats.planned >= state.maxPerRun) {
      stats.capped += 1;
      continue;
    }
    let user = null;
    if (resolveUsers) {
      try {
        user = await resolveDiscordUser(client, guild, entry.nation);
      } catch (error) {
        user = null;
      }
      await sleep(100);
    }
    if (resolveUsers && !user) {
      stats.noDiscord += 1;
      continue;
    }
    entries.push({ ...entry, user });
    stats.planned += 1;
    for (const item of entry.items) perCheck[item.check.key] += 1;
  }

  return { entries, stats, perCheck };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

async function sendPlan(plan, state, guildId, { now = Date.now() } = {}) {
  const result = { sent: 0, failed: 0 };

  for (const entry of plan.entries) {
    let allSent = true;
    for (const message of buildDmMessages(entry.nation, entry.items, state)) {
      try {
        await entry.user.send({ embeds: [message.embed] });
        // Remember it straight away so a crash can't cause a repeat.
        updateCheckDms(guildId, (s) => {
          for (const item of message.items) s.lastNotified[`${entry.nation.id}:${item.check.key}`] = new Date(now).toISOString();
        });
      } catch (error) {
        allSent = false; // most often: the member has DMs from this server turned off
        break;
      }
      await sleep(400);
    }
    if (allSent) result.sent += 1;
    else result.failed += 1;
    await sleep(600); // be polite to Discord's DM limits
  }
  return result;
}

// One full run: work out who is due, message them, and note the time.
async function runCheckDmsForGuild(client, guild, settings, { keys, ignoreCooldown = false, now = Date.now() } = {}) {
  const state = loadCheckDms(guild.id);
  const useKeys = keys ?? enabledKeys(state);
  const empty = { members: 0, planned: 0, sent: 0, failed: 0, noDiscord: 0, capped: 0, onCooldown: 0 };
  if (useKeys.length === 0 || !settings.alliance?.id) return empty;

  const plan = await buildPlan(client, guild, settings, state, { keys: useKeys, ignoreCooldown, now });
  const sendResult = await sendPlan(plan, state, guild.id, { now });

  updateCheckDms(guild.id, (s) => {
    s.lastRunAt = new Date(now).toISOString();
    pruneNotes(s, now);
  });
  return { ...plan.stats, ...sendResult };
}

module.exports = { PLAIN, buildSection, buildDmMessages, buildPlan, sendPlan, runCheckDmsForGuild };
