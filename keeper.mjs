#!/usr/bin/env node
// Headless session keeper for the VPS: refreshes all wallets, alerts when a refresh token dies.
import { setTimeout as sleep } from 'node:timers/promises';
import {
  loadWallets, saveWallets, loadConfig,
  refreshWallet, walletHealth, claimDaily,
  tokenSecondsLeft, fmtDur, humanAmount, sendAlert, walletLabel, log, AuthError,
} from './core.mjs';

async function processWallet(w, cfg) {
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

  // 2) health + optional claim
  try {
    const { cc, mod, sub, reward } = await walletHealth(w, cfg);
    const bal = (b) => b && !b._err ? `${humanAmount(b.totalBalance ?? b.balance, b.decimals ?? 10)} ${b.symbol}` : `err`;
    const days = sub && !sub._err && sub.endAt ? ((new Date(sub.endAt) - Date.now()) / 86400000).toFixed(1) : '?';
    log(`${label}: ${bal(cc)} | ${bal(mod)} | sub ${sub?.status || '?'} (${days}d) | reward ${reward?.accruedQuantity ?? '?'}`);

    if (sub && !sub._err && Number(days) < 3 && !sub.autoRenew && !w.alertedSub) {
      w.alertedSub = true;
      await sendAlert(cfg, `⏳ Modulo wallet "${label}": subscription habis ${days}d lagi & autoRenew OFF.`);
    } else if (sub && !sub._err && (Number(days) >= 3 || sub.autoRenew)) w.alertedSub = false;

    if (cfg.keeper.enableClaim && reward && !reward._err) {
      const accrued = Number(reward.accruedQuantity ?? 0);
      if (accrued > 0 && accrued >= (cfg.keeper.claimMin || 0)) {
        try { await claimDaily(w, cfg); log(`${label}: claimed daily reward (${accrued})`); }
        catch (e) { log(`${label}: claim failed: ${e.message}`); }
      }
    }
  } catch (e) {
    if (e instanceof AuthError && !w.alertedDead) {
      w.dead = true; w.alertedDead = true; w.lastError = e.message;
      await sendAlert(cfg, `🔴 Modulo wallet "${label}": sesi invalid (${e.message}). Re-import sesi.`);
      log(`${label}: auth dead during health -> alerted`);
    } else log(`${label}: health error: ${e.message}`);
  }
}

async function cycle() {
  const cfg = loadConfig();
  const wallets = loadWallets();
  if (!wallets.length) { log('no wallets — add via `node cli.mjs`'); return { cfg, wallets }; }
  for (const w of wallets) await processWallet(w, cfg);
  saveWallets(wallets); // persist rotated tokens + alert flags
  return { cfg, wallets };
}

export async function runKeeper() {
  console.log('\n================ KEEPER MODE ================');
  console.log('Keeper jalan terus (loop). Menu TIDAK balik. Ctrl-C untuk stop.');
  console.log('============================================\n');
  log('=== keeper start ===');
  let cfg = (await cycle()).cfg;
  const min = cfg.keeper.checkEveryMin || 30;
  for (;;) {
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
