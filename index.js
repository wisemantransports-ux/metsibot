import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Explicitly load .env BEFORE any other imports
dotenv.config({ path: path.join(__dirname, '.env') });

console.log('BOT_TOKEN loaded:', !!process.env.BOT_TOKEN);
console.log('SUPABASE_URL loaded:', !!process.env.SUPABASE_URL);

// Error handlers to prevent silent crashes
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

// Dynamic import after env is loaded
(async () => {
  try {
    const { bot } = await import('./bot/bot.js');
    
    console.log('📱 Starting bot...');
    
    // Start bot with polling
    bot.launch();
    console.log('✅ MetsiBot is running and listening for messages...');

    // Handle shutdown
    process.once('SIGINT', () => {
      console.log('⏹️ Stopping bot...');
      bot.stop('SIGINT');
    });
    process.once('SIGTERM', () => {
      console.log('⏹️ Stopping bot...');
      bot.stop('SIGTERM');
    });
  } catch (error) {
    console.error('❌ Failed to start bot:', error.message);
    process.exit(1);
  }
})();