const express = require('express');
const admin = require('firebase-admin');

// Check and load credentials
if (!process.env.FIREBASE_CREDENTIALS) {
  console.error('FIREBASE_CREDENTIALS environment variable is not set!');
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://starx-network-default-rtdb.firebaseio.com"
  });
}

const db = admin.database();
const usersRef = db.ref('users');

// Constants
const MINING_DURATION_MS = 24 * 60 * 60 * 1000;
const BASE_COINS_PER_HOUR = 2.0;
const BOOST_PER_REFERRAL = 0.25;

// Firebase server time
async function getFirebaseServerTime() {
  const ref = db.ref('serverTimeForScript');
  await ref.set(admin.database.ServerValue.TIMESTAMP);
  const snap = await ref.once('value');
  return snap.val();
}

// Count active referrals
async function getActiveReferralCount(referralCode) {
  if (!referralCode) return 0;
  const usersSnap = await usersRef.orderByChild('referredBy').equalTo(referralCode).once('value');
  let count = 0;
  usersSnap.forEach(child => {
    const mining = child.child('mining').val();
    if (mining && mining.isMining) count++;
  });
  return count;
}

// Process user
async function processUser(uid, userData, now) {
  const mining = userData.mining;
  if (!mining || !mining.isMining || !mining.startTime) return;

  const lastUpdate = mining.lastUpdate || mining.startTime;
  const miningEndTime = mining.startTime + MINING_DURATION_MS;
  const creditUntil = Math.min(now, miningEndTime);

  const isMiningDone = creditUntil >= miningEndTime;
  const elapsedMinutes = isMiningDone
    ? Math.floor((miningEndTime - lastUpdate) / (60 * 1000))
    : Math.round((creditUntil - lastUpdate) / (60 * 1000));

  if (elapsedMinutes <= 0) return;

  let speedBoost = 0.0;
  if (userData.referralCode) {
    speedBoost = await getActiveReferralCount(userData.referralCode) * BOOST_PER_REFERRAL;
  }

  // ✅ Include user’s custom boostRate if available
  const boostRate = Number(userData.boostRate) || 0.0;
  const totalBoost = speedBoost + boostRate;

  const coinsPerMinute = (BASE_COINS_PER_HOUR + totalBoost) / 60.0;
  const coinsToAdd = elapsedMinutes * coinsPerMinute;
  const prevBalance = Number(userData.balance) || 0;
  const newBalance = prevBalance + coinsToAdd;

  await usersRef.child(uid).update({
    balance: newBalance,
    'mining/isMining': !isMiningDone,
    'mining/lastUpdate': creditUntil,
  });

  console.log(
    `User ${uid}: +${coinsToAdd.toFixed(5)} coins (boost: ${totalBoost.toFixed(2)} [ref:${speedBoost.toFixed(2)}, rate:${boostRate.toFixed(2)}]), minutes: ${elapsedMinutes}, mining ${isMiningDone ? "ended" : "continues"}.`
  );
}

// Run mining credit job
async function runMiningJob() {
  const now = await getFirebaseServerTime();
  const snapshot = await usersRef.once('value');
  const users = snapshot.val() || {};

  await Promise.all(
    Object.entries(users).map(([uid, userData]) => processUser(uid, userData, now))
  );

  console.log('✅ Mining job completed.');
}

// Express server
const app = express();

// Dashboard route
app.get('/', async (req, res) => {
  try {
    const snapshot = await usersRef.once('value');
    const users = snapshot.val() || {};
    let html = `
      <html>
      <head>
        <title>Mining User Balances</title>
        <style>
          body { font-family: sans-serif; margin:40px;}
          table { border-collapse: collapse; width: 100%; }
          th, td { border: 1px solid #ddd; padding: 8px; }
          th { background: #f4f4f4; }
        </style>
      </head>
      <body>
        <h2>Mining User Balances</h2>
        <table>
          <thead>
            <tr>
              <th>User ID</th>
              <th>Balance</th>
              <th>Is Mining?</th>
              <th>Last Update</th>
            </tr>
          </thead>
          <tbody>
    `;
    Object.entries(users).forEach(([uid, user]) => {
      html += `
        <tr>
          <td>${uid}</td>
          <td>${(user.balance || 0).toFixed(5)}</td>
          <td>${user.mining && user.mining.isMining ? "Yes" : "No"}</td>
          <td>${user.mining && user.mining.lastUpdate ? new Date(user.mining.lastUpdate).toLocaleString() : ""}</td>
        </tr>
      `;
    });
    html += `
          </tbody>
        </table>
      </body>
      </html>
    `;
    res.send(html);
  } catch (err) {
    res.status(500).send('Error fetching balances');
  }
});

// Trigger route for mining cron
app.get('/run', async (req, res) => {
  try {
    await runMiningJob();
    res.send('Mining job completed ✅');
  } catch (err) {
    console.error('Error in /run:', err);
    res.status(500).send('❌ Error occurred');
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});
