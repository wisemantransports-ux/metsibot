import { Telegraf } from 'telegraf';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

export const bot = new Telegraf(process.env.BOT_TOKEN);

// ===== SETUP =====
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// In-memory cache (fallback and fast access)
const userCache = {}; // keyed by telegram_id

// Helpers for messaging style
const EM = {
  water: '💧',
  elec: '⚡',
  warn: '⚠️',
  graph: '📊',
  calendar: '📅'
};

// ===== SUPABASE HELPERS =====
async function initUserRow(telegramId) {
  const { data: existing } = await supabase.from('users').select('*').eq('telegram_id', String(telegramId)).limit(1).maybeSingle();
  if (!existing) {
    const payload = {
      telegram_id: String(telegramId),
      plan: 'free',
      is_paid: false,
      free_alert_used: false,
      water_current_balance: 0,
      water_daily_usage: 0,
      electricity_current_balance: 0,
      electricity_daily_usage: 0,
      water_topups: [],
      electricity_topups: [],
      alert_threshold_money: null,
      profile_count: 1
    };
    const { data } = await supabase.from('users').insert(payload).select().maybeSingle();
    return data || payload;
  }
  return existing;
}

async function getUserRow(telegramId) {
  const { data } = await supabase.from('users').select('*').eq('telegram_id', String(telegramId)).limit(1).maybeSingle();
  return data || null;
}

async function updateUserRow(telegramId, attrs) {
  await supabase.from('users').update(attrs).eq('telegram_id', String(telegramId));
}

async function recordAlertRow(telegramId, utilityType, thresholdMoney, currentBalance) {
  // Insert alert record using Supabase as single source of truth
  const payload = {
    telegram_id: String(telegramId),
    utility_type: utilityType,
    threshold_money: Number(thresholdMoney),
    current_balance: Number(currentBalance),
    triggered_at: new Date().toISOString()
  };
  const { data, error } = await supabase.from('alerts').insert(payload).select().maybeSingle();
  if (error) console.error('recordAlertRow error', error.message || error);
  return data;
}

async function getLatestAlert(telegramId, utilityType) {
  const { data } = await supabase.from('alerts').select('*').eq('telegram_id', String(telegramId)).eq('utility_type', utilityType).order('triggered_at', { ascending: false }).limit(1).maybeSingle();
  return data || null;
}

// ===== INTERNAL DATA HELPERS (Utility agnostic) =====
function ensureUserCache(telegramId) {
  if (!userCache[telegramId]) {
    userCache[telegramId] = {
      utilities: {
        water: { remaining: 0, purchases: [], alertThreshold: null },
        electricity: { remaining: 0, purchases: [], alertThreshold: null }
      },
      isPaid: false,
      freeAlertUsed: false
    };
  }
  return userCache[telegramId];
}

// price per unit helper: use most recent purchase rate if available
function getLastRate(purchases) {
  if (!purchases || purchases.length === 0) return null;
  const last = purchases[purchases.length - 1];
  if (!last.amountPaid || !last.unitsReceived) return null;
  return last.amountPaid / last.unitsReceived;
}

// ===== CORE UTILITY HELPERS =====
async function setBalance(telegramId, utilityType, amount) {
  const userRow = await initUserRow(telegramId);
  const key = utilityType === 'water' ? 'water_current_balance' : 'electricity_current_balance';
  await updateUserRow(telegramId, { [key]: Number(amount) });
  ensureUserCache(telegramId).utilities[utilityType].remaining = Number(amount);
}

async function addPurchase(telegramId, utilityType, amountPaid, unitsReceived) {
  const userRow = await initUserRow(telegramId);
  const topupsKey = utilityType === 'water' ? 'water_topups' : 'electricity_topups';
  const balanceKey = utilityType === 'water' ? 'water_current_balance' : 'electricity_current_balance';

  const existing = (userRow[topupsKey] && Array.isArray(userRow[topupsKey])) ? userRow[topupsKey] : [];
  const record = { amountPaid: Number(amountPaid), unitsReceived: Number(unitsReceived), date: new Date().toISOString() };
  const newArr = [...existing, record];

  const newBalance = Number(userRow[balanceKey] || 0) + Number(unitsReceived);
  await updateUserRow(telegramId, { [topupsKey]: newArr, [balanceKey]: newBalance });

  // update cache
  const cache = ensureUserCache(telegramId);
  cache.utilities[utilityType].purchases = newArr;
  cache.utilities[utilityType].remaining = newBalance;
}

async function setAlert(telegramId, amountInPula) {
  // store threshold money centrally; resolution to units happens on check
  await initUserRow(telegramId);
  await updateUserRow(telegramId, { alert_threshold_money: Number(amountInPula) });
}

async function getStatus(telegramId) {
  const row = await initUserRow(telegramId);
  return {
    water: {
      remaining: Number(row.water_current_balance || 0),
      daily_liters: Number(row.water_daily_usage || 0),
      purchases: row.water_topups || []
    },
    electricity: {
      remaining: Number(row.electricity_current_balance || 0),
      daily_kwh: Number(row.electricity_daily_usage || 0),
      purchases: row.electricity_topups || []
    },
    isPaid: !!row.is_paid,
    freeAlertUsed: !!row.free_alert_used,
    alertThresholdMoney: row.alert_threshold_money
  };
}

async function getHistory(telegramId, utilityType) {
  const row = await initUserRow(telegramId);
  const topupsKey = utilityType === 'water' ? 'water_topups' : 'electricity_topups';
  return row[topupsKey] || [];
}

// ===== ALERT CHECKING =====
async function checkAlert(telegramId, utilityType, ctx) {
  try {
    // Always fetch fresh user row from Supabase
    const row = await getUserRow(telegramId);
    if (!row) return;
    const plan = row.plan || (row.is_paid ? 'paid' : 'free');
    const freeUsed = !!row.free_alert_used;
    const alertMoney = row.alert_threshold_money;
    if (!alertMoney) return; // no money-based alert set

    // get purchases for rate
    const purchases = utilityType === 'water' ? (row.water_topups || []) : (row.electricity_topups || []);
    const lastRate = getLastRate(purchases);
    if (!lastRate) return; // cannot compute unit threshold without price info

    const unitThreshold = Number(alertMoney) / lastRate; // units (m3 or kWh)
    const currentBalance = utilityType === 'water' ? Number(row.water_current_balance || 0) : Number(row.electricity_current_balance || 0);

    if (currentBalance > unitThreshold) return; // not yet below threshold

    // duplicate prevention: check latest alert for this user+utility
    const latest = await getLatestAlert(telegramId, utilityType);
    if (latest) {
      const lastTime = new Date(latest.triggered_at).getTime();
      const now = Date.now();
      const secondsSince = (now - lastTime) / 1000;
      // suppress duplicate alert within 3600s (1 hour)
      if (secondsSince < 3600) {
        console.log(`Duplicate alert suppressed for ${telegramId} (${utilityType}), ${Math.round(secondsSince)}s since last`);
        return;
      }
    }

    // Now enforce plan rules
    if (plan === 'free') {
      if (freeUsed) {
        // do not send alert, prompt upgrade
        console.log(`Free alert already used for ${telegramId}`);
        await ctx.telegram.sendMessage(telegramId, `${EM.warn} You've used your free alert.\nUpgrade to Premium (P30 Household / P50 Business) for unlimited alerts and full tracking.`);
        return;
      }

      // send alert, mark used, insert alert
      const title = utilityType === 'water' ? `${EM.water} WATER ALERT` : `${EM.elec} ELECTRICITY ALERT`;
      await ctx.telegram.sendMessage(telegramId, `${EM.warn} ${title}\nYour ${utilityType} balance is low (≈ ${currentBalance.toFixed(3)}).\nThreshold set: P${alertMoney} (~${unitThreshold.toFixed(3)} units).`);
      await updateUserRow(telegramId, { free_alert_used: true, last_alert_date: new Date().toISOString() });
      await recordAlertRow(telegramId, utilityType, alertMoney, currentBalance);
      console.log(`Alert triggered for ${telegramId}`);
      console.log('Free alert used');
    } else {
      // paid or other plans — always send and log
      const title = utilityType === 'water' ? `${EM.water} WATER ALERT` : `${EM.elec} ELECTRICITY ALERT`;
      await ctx.telegram.sendMessage(telegramId, `${EM.warn} ${title}\nYour ${utilityType} balance is low (≈ ${currentBalance.toFixed(3)}).\nThreshold set: P${alertMoney} (~${unitThreshold.toFixed(3)} units).`);
      await recordAlertRow(telegramId, utilityType, alertMoney, currentBalance);
      console.log(`Alert triggered for ${telegramId}`);
      console.log('Paid alert logged');
    }
  } catch (err) {
    console.error('checkAlert error', err?.message || err);
  }
}

// ===== PREDICTION HELPERS =====
function predictDaysWater(remaining_m3, people_or_units, daily_liters_per_person) {
  // remaining_m3 -> liters
  const liters = Number(remaining_m3) * 1000;
  const totalDaily = Number(people_or_units) * Number(daily_liters_per_person);
  if (!totalDaily || totalDaily <= 0) return null;
  return liters / totalDaily;
}

function predictDaysElec(remaining_kwh, daily_kwh) {
  if (!daily_kwh || daily_kwh <= 0) return null;
  return Number(remaining_kwh) / Number(daily_kwh);
}

// ===== MIDDLEWARE =====
bot.use(async (ctx, next) => {
  try {
    if (ctx.from && ctx.from.id) {
      await initUserRow(ctx.from.id);
    }
  } catch (err) {
    console.error('middleware initUserRow', err?.message || err);
  }
  return next();
});

// ===== COMMANDS =====

// ===== HELP & START =====
bot.start(async (ctx) => {
  try {
    await initUserRow(ctx.from.id);
    await ctx.reply(`${EM.graph} Welcome to Prepaid Utility Tracker!\n\nTrack water and electricity, set money-based low alerts, and manage top-ups.`);
    await ctx.telegram.sendMessage(ctx.chat.id, `📌 Commands\n\n/mode <household|business> - select mode\n/profile <number> - people or units\n/usage <number> - daily usage (L or kWh)\n/water <m³> - set water balance\n/electricity <kWh> - set electricity balance\n/addwater <Pula> <m³> - log water top-up\n/addelec <Pula> <kWh> - log electricity top-up\n/alert <Pula> - set money-based alert\n/status - show both statuses\n/history - show both histories\n/help - show this message`);
  } catch (err) {
    console.error('start error', err?.message || err);
  }
});

bot.command('help', async (ctx) => {
  try {
    await ctx.reply(`📘 Help\n\nUse /mode to set household or business, then set your /profile and /usage.\nSet balances with /water and /electricity.\nUse /alert to set a money-based low alert (Pula).\nHistory and status commands show your top-ups and predictions.`);
  } catch (err) {
    console.error('help error', err?.message || err);
  }
});

// ===== MODE, PROFILE, USAGE =====
bot.command('mode', async (ctx) => {
  try {
    const args = ctx.message.text.split(' ');
    const id = String(ctx.from.id);
    if (!args[1] || !['household', 'business'].includes(args[1].toLowerCase())) {
      return ctx.reply('❌ Please specify mode: /mode <household|business>');
    }
    const mode = args[1].toLowerCase();
    await updateUserRow(id, { mode });
    await ctx.reply(`✅ Mode set to ${mode}`);
  } catch (err) {
    console.error('mode error', err?.message || err);
  }
});

bot.command('profile', async (ctx) => {
  try {
    const args = ctx.message.text.split(' ');
    const id = String(ctx.from.id);
    const num = Number(args[1]);
    if (!num || num <= 0) return ctx.reply('❌ Usage: /profile <number>');
    await updateUserRow(id, { profile_count: num });
    await ctx.reply(`✅ Profile set: ${num}`);
  } catch (err) {
    console.error('profile error', err?.message || err);
  }
});

bot.command('usage', async (ctx) => {
  try {
    const args = ctx.message.text.split(' ');
    const id = String(ctx.from.id);
    const num = Number(args[1]);
    if (!num || num <= 0) return ctx.reply('❌ Usage: /usage <number> — enter litres/day for water or kWh/day for electricity');
    // Save both as defaults; user should specify which utility they meant via context
    await updateUserRow(id, { water_daily_usage: Number(num), electricity_daily_usage: Number(num) });
    await ctx.reply(`✅ Daily usage set: ${num}`);
  } catch (err) {
    console.error('usage error', err?.message || err);
  }
});

// ===== WATER COMMANDS =====
bot.command('water', async (ctx) => {
  try {
    const args = ctx.message.text.split(' ');
    const id = String(ctx.from.id);
    const num = Number(args[1]);
    if (isNaN(num)) return ctx.reply('❌ Usage: /water <m³> — set your current water balance');
    await setBalance(id, 'water', Number(num));
    await ctx.reply(`${EM.water} Water balance updated: ${Number(num).toFixed(3)} m³`);
    await checkAlert(id, 'water', ctx);
  } catch (err) {
    console.error('water error', err?.message || err);
  }
});

bot.command('addwater', async (ctx) => {
  try {
    const args = ctx.message.text.split(' ');
    const id = String(ctx.from.id);
    const amountPaid = Number(args[1]);
    const units = Number(args[2]);
    if (!amountPaid || !units) return ctx.reply('❌ Usage: /addwater <Pula> <m³>');
    await addPurchase(id, 'water', amountPaid, units);
    await ctx.reply(`${EM.water} Top-up recorded: P${amountPaid} → ${units} m³`);
    await checkAlert(id, 'water', ctx);
  } catch (err) {
    console.error('addwater error', err?.message || err);
  }
});

bot.command('setwateralert', async (ctx) => {
  try {
    const args = ctx.message.text.split(' ');
    const id = String(ctx.from.id);
    const pula = Number(args[1]);
    if (!pula || pula <= 0) return ctx.reply('❌ Usage: /setwateralert <Pula>');
    await setAlert(id, pula);
    await ctx.reply(`${EM.warn} Water money-based alert set: P${pula}`);
  } catch (err) {
    console.error('setwateralert error', err?.message || err);
  }
});

// ===== ELECTRICITY COMMANDS =====
bot.command('electricity', async (ctx) => {
  try {
    const args = ctx.message.text.split(' ');
    const id = String(ctx.from.id);
    const num = Number(args[1]);
    if (isNaN(num)) return ctx.reply('❌ Usage: /electricity <kWh> — set your current electricity balance');
    await setBalance(id, 'electricity', Number(num));
    await ctx.reply(`${EM.elec} Electricity balance updated: ${Number(num).toFixed(3)} kWh`);
    await checkAlert(id, 'electricity', ctx);
  } catch (err) {
    console.error('electricity error', err?.message || err);
  }
});

bot.command('addelec', async (ctx) => {
  try {
    const args = ctx.message.text.split(' ');
    const id = String(ctx.from.id);
    const amountPaid = Number(args[1]);
    const units = Number(args[2]);
    if (!amountPaid || !units) return ctx.reply('❌ Usage: /addelec <Pula> <kWh>');
    await addPurchase(id, 'electricity', amountPaid, units);
    await ctx.reply(`${EM.elec} Top-up recorded: P${amountPaid} → ${units} kWh`);
    await checkAlert(id, 'electricity', ctx);
  } catch (err) {
    console.error('addelec error', err?.message || err);
  }
});

bot.command('setelecalert', async (ctx) => {
  try {
    const args = ctx.message.text.split(' ');
    const id = String(ctx.from.id);
    const pula = Number(args[1]);
    if (!pula || pula <= 0) return ctx.reply('❌ Usage: /setelecalert <Pula>');
    await setAlert(id, pula);
    await ctx.reply(`${EM.warn} Electricity money-based alert set: P${pula}`);
  } catch (err) {
    console.error('setelecalert error', err?.message || err);
  }
});

// ===== STATUS & HISTORY =====
bot.command('status', async (ctx) => {
  try {
    const id = String(ctx.from.id);
    const row = await initUserRow(id);
    const mode = row.mode || 'household';
    const profileCount = Number(row.profile_count || 1);
    const waterDaily = Number(row.water_daily_usage || 0);
    const elecDaily = Number(row.electricity_daily_usage || 0);
    const waterRemaining = Number(row.water_current_balance || 0);
    const elecRemaining = Number(row.electricity_current_balance || 0);

    const waterDays = predictDaysWater(waterRemaining, profileCount, waterDaily);
    const elecDays = predictDaysElec(elecRemaining, elecDaily);

    let msg = `${EM.graph} HOUSEHOLD STATUS 🏠\n`;
    msg += `People/Units: ${profileCount}\n`;
    msg += `Daily per person/unit: ${waterDaily} L/day\n`;
    msg += `Remaining water: ${waterRemaining.toFixed(3)} m³\n`;
    msg += `Approx. days left: ${waterDays ? waterDays.toFixed(1) + ' days' : '—'}\n\n`;

    msg += `${EM.graph} ELECTRICITY STATUS ${EM.elec}\n`;
    msg += `Daily usage: ${elecDaily} kWh/day\n`;
    msg += `Remaining electricity: ${elecRemaining.toFixed(3)} kWh\n`;
    msg += `Approx. days left: ${elecDays ? elecDays.toFixed(1) + ' days' : '—'}`;

    await ctx.reply(msg);
  } catch (err) {
    console.error('status error', err?.message || err);
  }
});

bot.command('history', async (ctx) => {
  try {
    const id = String(ctx.from.id);
    const row = await initUserRow(id);
    const waterTopups = row.water_topups || [];
    const elecTopups = row.electricity_topups || [];

    let msg = `${EM.calendar} WATER PURCHASE HISTORY\n`;
    if (waterTopups.length === 0) msg += `No water top-ups recorded.\n\n`;
    else {
      waterTopups.forEach((t, i) => {
        msg += `${i + 1}. P${t.amountPaid} → ${t.unitsReceived} m³ (${new Date(t.date).toLocaleString()})\n`;
      });
      msg += `\n`;
    }

    msg += `${EM.calendar} ELECTRICITY PURCHASE HISTORY\n`;
    if (elecTopups.length === 0) msg += `No electricity top-ups recorded.`;
    else {
      elecTopups.forEach((t, i) => {
        msg += `${i + 1}. P${t.amountPaid} → ${t.unitsReceived} kWh (${new Date(t.date).toLocaleString()})\n`;
      });
    }

    await ctx.reply(msg);
  } catch (err) {
    console.error('history error', err?.message || err);
  }
});

// ===== MONEY-BASED ALERT (generic) =====
bot.command('alert', async (ctx) => {
  try {
    const args = ctx.message.text.split(' ');
    const id = String(ctx.from.id);
    const pula = Number(args[1]);
    if (!pula || pula <= 0) return ctx.reply('❌ Usage: /alert <Pula> — sets money-based alert for both utilities');
    await setAlert(id, pula);
    await ctx.reply(`${EM.warn} Money-based alert set to P${pula} for utilities. When your balance (converted) drops below this value an alert will trigger.`);
  } catch (err) {
    console.error('alert error', err?.message || err);
  }
});

// ===== EXPORT/END =====
// All handlers wrapped in try/catch above; bot exported at top

// Expose helpers for testing
export { checkAlert, recordAlertRow, getUserRow, supabase };
