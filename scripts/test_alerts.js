import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { checkAlert, getUserRow } from '../bot/bot.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

function makeCtx(telegramId) {
  const sent = [];
  return {
    telegram: {
      sendMessage: async (chatId, text) => {
        const msg = { chatId, text };
        sent.push(msg);
        console.log('MOCK SEND:', text);
        return msg;
      }
    },
    _sent: sent
  };
}

async function resetAlertsFor(id) {
  await supabase.from('alerts').delete().eq('telegram_id', String(id));
}

async function run() {
  // Test Scenario 1 - Free User
  const freeId = '9000001';
  console.log('\n--- Scenario 1: Free User ---');
  // prepare user with plan=free, free_alert_used=false, alert_threshold_money=30
  const freeUser = {
    telegram_id: freeId,
    plan: 'free',
    is_paid: false,
    free_alert_used: false,
    electricity_current_balance: 12, // units
    electricity_daily_usage: 5,
    electricity_topups: [{ amountPaid: 100, unitsReceived: 50, date: new Date().toISOString() }],
    alert_threshold_money: 30,
    profile_count: 1
  };
  await supabase.from('users').upsert(freeUser, { onConflict: 'telegram_id' });
  await resetAlertsFor(freeId);

  const ctxFree = makeCtx(freeId);
  console.log('-> Triggering first alert (should send)');
  await checkAlert(freeId, 'electricity', ctxFree);

  const alerts1 = await supabase.from('alerts').select('*').eq('telegram_id', freeId);
  if (alerts1.error) console.error('alerts1 error', alerts1.error.message || alerts1.error);
  const userAfter1 = await supabase.from('users').select('*').eq('telegram_id', freeId).maybeSingle();
  if (userAfter1.error) console.error('userAfter1 error', userAfter1.error.message || userAfter1.error);
  console.log('Alerts rows count:', (alerts1.data && alerts1.data.length) || 0);
  console.log('users.free_alert_used:', userAfter1.data ? userAfter1.data.free_alert_used : 'UNKNOWN');

  console.log('\n-> Triggering second alert (should be blocked)');
  await checkAlert(freeId, 'electricity', ctxFree);
  const alerts2 = await supabase.from('alerts').select('*').eq('telegram_id', freeId);
  if (alerts2.error) console.error('alerts2 error', alerts2.error.message || alerts2.error);
  console.log('Alerts rows count after second trigger:', (alerts2.data && alerts2.data.length) || 0);

  // Scenario 2 - Paid User
  const paidId = '9000002';
  console.log('\n--- Scenario 2: Paid User ---');
  const paidUser = {
    telegram_id: paidId,
    plan: 'household',
    is_paid: true,
    free_alert_used: false,
    electricity_current_balance: 12,
    electricity_topups: [{ amountPaid: 100, unitsReceived: 50, date: new Date().toISOString() }],
    alert_threshold_money: 30,
    profile_count: 1
  };
  await supabase.from('users').upsert(paidUser, { onConflict: 'telegram_id' });
  await resetAlertsFor(paidId);

  const ctxPaid = makeCtx(paidId);
  console.log('-> Triggering first paid alert (should send and log)');
  await checkAlert(paidId, 'electricity', ctxPaid);
  const paidAlerts1 = await supabase.from('alerts').select('*').eq('telegram_id', paidId);
  if (paidAlerts1.error) console.error('paidAlerts1 error', paidAlerts1.error.message || paidAlerts1.error);
  console.log('Paid alerts count after 1st:', (paidAlerts1.data && paidAlerts1.data.length) || 0);

  console.log('-> Advancing latest alert time to >1 hour ago and triggering again (should send)');
  // set latest triggered_at to 2 hours ago
  if (paidAlerts1.data && paidAlerts1.data.length > 0) {
    const latestId = paidAlerts1.data[0].id;
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    await supabase.from('alerts').update({ triggered_at: twoHoursAgo }).eq('id', latestId);
  }
  await checkAlert(paidId, 'electricity', ctxPaid);
  const paidAlerts2 = await supabase.from('alerts').select('*').eq('telegram_id', paidId);
  console.log('Paid alerts count after 2nd:', paidAlerts2.data.length);

  console.log('\n--- Final DB checks ---');
  const finalFreeUser = await supabase.from('users').select('*').eq('telegram_id', freeId).maybeSingle();
  const finalPaidUser = await supabase.from('users').select('*').eq('telegram_id', paidId).maybeSingle();
  const finalFreeAlerts = await supabase.from('alerts').select('*').eq('telegram_id', freeId);
  const finalPaidAlerts = await supabase.from('alerts').select('*').eq('telegram_id', paidId);

  console.log('Free user record:', finalFreeUser.data);
  console.log('Free user alerts:', finalFreeAlerts.data.length);
  console.log('Paid user record:', finalPaidUser.data);
  console.log('Paid user alerts:', finalPaidAlerts.data.length);
}

run().then(() => console.log('\nTESTS COMPLETE')).catch((e) => console.error('TEST ERROR', e));
