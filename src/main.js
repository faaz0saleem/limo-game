import { Poki } from './poki.js';
import { Game } from './game.js';
import { CONFIG } from './config.js';

async function main() {
  if (!window.Matter) {
    document.getElementById('boot-error').style.display = 'block';
    throw new Error('Matter.js failed to load');
  }
  await Poki.init();
  const game = new Game(document.getElementById('app'));
  window.__limo = game; // handy for tuning from the console
  window.__CONFIG = CONFIG;
  await game.boot();
}

main().catch((err) => {
  console.error(err);
  const el = document.getElementById('boot-error');
  if (el) {
    el.style.display = 'block';
    el.textContent = 'Failed to start: ' + err.message;
  }
});
