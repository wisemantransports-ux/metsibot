import { Telegraf, session } from 'telegraf';
import { supabase } from '../db/supabase.js';

export const bot = new Telegraf(process.env.BOT_TOKEN);

// Enable session
bot.use(session());

// START command
bot.start((ctx) => {
  ctx.reply(
    'Welcome to MetsiBot 👋\n\n' +
    'Track water usage, predict remaining balance, and manage receipts.\n\n' +
    'Use /help to see commands.'
  );
});

// HELP command
bot.help((ctx) => {
  ctx.reply(
    '/profile - Set number of people in your household\n' +
    '/water - Update remaining water\n' +
    '/status - View water prediction'
  );
});

// PROFILE command
bot.command('profile', async (ctx) => {
  ctx.session.profile = ctx.session.profile || {};

  const message = ctx.message.text.split(' ');
  const people = parseInt(message[1]);

  if (!people || people <= 0) {
    return ctx.reply('Please provide a valid number of people. Example: /profile 4');
  }

  ctx.session.profile.people = people;

  // Optional: save to Supabase
  // await supabase.from('users').upsert({ telegram_id: ctx.from.id, people });

  // ✅ FIXED TEMPLATE LITERAL
  ctx.reply(Profile saved! Number of people in household: ${people});
});

// WATER command
bot.command('water', async (ctx) => {
  ctx.session.water = ctx.session.water || {};

  const message = ctx.message.text.split(' ');
  const remaining = parseFloat(message[1]);

  if (!remaining || remaining < 0) {
    return ctx.reply('Please provide a valid remaining water amount. Example: /water 100');
  }

  ctx.session.water.remaining = remaining;

  // Optional: save to Supabase
  // await supabase.from('water').upsert({ telegram_id: ctx.from.id, remaining });

  ctx.reply(Water balance updated: ${remaining});
});

// STATUS command
bot.command('status', (ctx) => {
  const people = ctx.session.profile?.people || 1;
  const remaining = ctx.session.water?.remaining || 0;

  // Simple prediction logic
  const approx_per_person = 10; // example liters per day
  const days_remaining = remaining / (people * approx_per_person);

  ctx.reply(Water balance updated: ${remaining});
ctx.reply(
  Household: ${people} people\n +
  Remaining water: ${remaining}\n +
  Approximate days left: ${days_remaining.toFixed(1)} days
);