import 'dotenv/config';
import { startBot, stopBot } from './slack-bot.js';

// Start the bot
startBot().catch((error) => {
  console.error('Failed to start bot:', error);
  process.exit(1);
});

// Shutdown state
let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    console.log(`Already shutting down, ignoring ${signal}`);
    return;
  }
  isShuttingDown = true;
  console.log(`Received ${signal}, shutting down...`);

  // Force exit after 6 seconds (slightly longer than codex.stop() max 5s)
  const forceExit = setTimeout(() => {
    console.error('Shutdown timed out after 6s, forcing exit...');
    process.exit(1);
  }, 6000);
  forceExit.unref(); // Don't keep process alive just for this timer

  try {
    await stopBot();
    clearTimeout(forceExit);
    console.log('Shutdown complete');
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExit);
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
}

// Graceful shutdown handlers
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
