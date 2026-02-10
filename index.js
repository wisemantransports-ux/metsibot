import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const _dirname = path.dirname(_filename);

// Explicitly load .env
dotenv.config({ path: path.join(__dirname, '.env') });

import { bot } from './bot/bot.js';

console.log('BOT_TOKEN loaded:', !!process.env.BOT_TOKEN);

bot.launch();
console.log('MetsiBot is running...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));