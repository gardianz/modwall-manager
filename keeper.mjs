#!/usr/bin/env node
// Headless session keeper for the VPS: refreshes all wallets, runs the daily quest automation
// when enabled, and alerts when a refresh token dies.
import { setTimeout as sleep } from 'node:timers/promises';
import {
  loadWallets, saveWallets, loadConfig,
  refreshWallet, walletHealth, fmtBalances,
  tokenSecondsLeft, fmtDur, sendAlert, walletLabel, log, AuthError,
} from './core.mjs';
import { runAutoTasks } from './autotask.mjs';

async function processWallet(w, wallets, cfg) {
  const label = walletLabel(w);
  const left = tokenSecondsLeft(w.accessToken);
  const skew = cfg.keeper.refreshSkewSec;

  // 1) keep the token alive
  if (left < skew) {
    if (!w.refreshToken) {
      // no way to renew -> alert once
      if (left <= 0 && !w.alertedDead) {
        w.dead = true; w.alertedDead = true; w.lastError = 'access token expired, no refresh token';
        await sendAlert(cfg, `⚠️ Modulo wallet "${label}": access token expired dan TIDAK ada refresh token. Re-import sesi.`);
        log(`${label}: expired, no RT -> alerted`);
      }
      return;
    }
    try {
      await refreshWallet(w, cfg);
      if (w.dead || w.alertedDead) {
        w.dead = false; w.alertedDead = false; w.lastError = undefined;
        await sendAlert(cfg, `✅ Modulo wallet "${label}": sesi pulih, token kembali aktif.`);
        log(`${label}: recovered`);
      }
      log(`${label}: refreshed (valid ${fmtDur(tokenSecondsLeft(w.accessToken))})`);
    } catch (e) {
      // refresh token dead (invalid_grant) -> alert once on transition
      if (!w.alertedDead) {
        w.dead = true; w.alertedDead = true; w.lastError = e.message;
        await sendAlert(cfg, `🔴 Modulo wallet "${label}": REFRESH TOKEN MATI (${e.message}). Login ulang di laptop & re-import sesi ke VPS.`);
        log(`${label}: RT DEAD -> alerted (${e.message})`);
      } else {
        log(`${label}: still dead (${e.message})`);
      }
      return;
    }
  }

  // 2) health
  try {
    const { balances, sub, points, counts } = await walletHealth(w, cfg);
    const days = sub && !sub._err && sub.endAt ? ((new Date(sub.endAt) - Date.now()) / 86400000).toFixed(1) : '?';
    log(`${label}: ${fmtBalances(balances)} | sub ${sub?.status || '?'} (${days}d) | poin ${points?.claimable?.pointsBalance ?? '?'} | quest siap ${counts?.active ?? '?'}`);

    if (sub && !sub._err && Number(days) < 3 && !w.alertedSub) {
      w.alertedSub = true;
      await sendAlert(cfg, `⏳ Modulo wallet "${label}": subscription habis ${days}d lagi.`);
    } else if (sub && !sub._err && Number(days) >= 3) w.alertedSub = false;
  } catch (e) {
    if (e instanceof AuthError && !w.alertedDead) {
      w.dead = true; w.alertedDead = true; w.lastError = e.message;
      await sendAlert(cfg, `🔴 Modulo wallet "${label}": sesi invalid (${e.message}). Re-import sesi.`);
      log(`${label}: auth dead during health -> alerted`);
      return;
    }
    log(`${label}: health error: ${e.message}`);
  }

  // 3) daily quest automation (opt-in via config: autoTask.enabled)
  if (!cfg.autoTask?.enabled) return;
  try {
    const rep = await runAutoTasks(w, wallets, cfg, { onLog: (m) => log(m) });
    if (rep.errors.length) log(`${label}: auto task error: ${rep.errors.join(' | ')}`);
  } catch (e) {
    log(`${label}: auto task fatal: ${e.message}`);
  }
}

async function cycle() {
  const cfg = loadConfig();
  const wallets = loadWallets();
  if (!wallets.length) { log('no wallets — add via `node cli.mjs`'); return { cfg, wallets }; }
  for (const w of wallets) {
    await processWallet(w, wallets, cfg);
    saveWallets(wallets); // persist rotated tokens as we go, not only at the end
  }
  return { cfg, wallets };
}

export async function runKeeper() {
  console.log('\n================ KEEPER MODE ================');
  console.log('Keeper jalan terus (loop). Menu TIDAK balik. Ctrl-C untuk stop.');
  console.log('============================================\n');
  log('=== keeper start ===');
  let cfg = (await cycle()).cfg;
  if (cfg.autoTask?.enabled) log('auto task: ON');
  for (;;) {
    const min = cfg.keeper.checkEveryMin || 30;
    log(`next check in ${min}m`);
    await sleep(min * 60 * 1000);
    try { cfg = (await cycle()).cfg; } catch (e) { log('cycle error:', e.message); }
  }
}

// run directly: node keeper.mjs   (once with --once)
if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--once')) { cycle().then(() => process.exit(0)); }
  else runKeeper();
}
