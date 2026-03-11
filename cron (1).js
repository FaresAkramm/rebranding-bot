const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { credential } = require("firebase-admin");

const SHEET_ID = "1wdBmHTmg5JdLujX-6P-MHXsoCjDwCLZWcF8BwJdlYEM";
const TG_TOKEN = process.env.TG_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(s => s.trim());
const SHEETS_CLIENT_EMAIL = process.env.SHEETS_CLIENT_EMAIL;
const SHEETS_PRIVATE_KEY = process.env.SHEETS_PRIVATE_KEY?.replace(/\\n/g, "\n");

function getDB() {
  if (!getApps().length) {
    initializeApp({
      credential: credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      }),
    });
  }
  return getFirestore();
}

async function sendTG(text) {
  for (const id of ADMIN_IDS) {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: id, text, parse_mode: "HTML" }),
    });
  }
}

// ══ GOOGLE SHEETS AUTH ══
async function getSheetsToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: SHEETS_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  })).toString("base64url");

  const { createSign } = require("crypto");
  const sign = createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(SHEETS_PRIVATE_KEY, "base64url");
  const jwt = `${header}.${payload}.${sig}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  return data.access_token;
}

async function appendToSheet(token, sheetName, rows) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(sheetName)}!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ values: rows }),
  });
}

async function ensureSheetHeaders(token, sheetName, headers) {
  // Check if sheet has headers
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(sheetName)}!A1:Z1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!data.values || !data.values[0] || data.values[0].length === 0) {
    // Add headers
    const setUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(sheetName)}!A1:append?valueInputOption=USER_ENTERED`;
    await fetch(setUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ values: [headers] }),
    });
  }
}

// ══ FEATURE 3: تسجيل الأسئلة الجديدة في Sheets ══
async function syncUnansweredToSheets(db) {
  try {
    const token = await getSheetsToken();
    const snap = await db.collection("unanswered_questions").get();
    const questions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    
    // Only today's questions
    const today = new Date().toISOString().slice(0, 10);
    const todayQs = questions.filter(q => q.createdAt && q.createdAt.slice(0, 10) === today);
    
    if (todayQs.length === 0) return 0;

    await ensureSheetHeaders(token, "الأسئلة", ["التاريخ", "الأكونت", "السؤال", "الإجابة", "الحالة"]);
    
    const rows = todayQs.map(q => [
      q.createdAt ? new Date(q.createdAt).toLocaleString("ar-EG") : "",
      q.accName || "",
      q.q || "",
      q.a || "",
      q.a ? "✅ متجاوب" : "⏳ في الانتظار",
    ]);
    
    await appendToSheet(token, "الأسئلة", rows);
    return todayQs.length;
  } catch(e) {
    console.error("Sheets sync error:", e.message);
    return 0;
  }
}

// ══ FEATURE 4: تنبيه العروض ══
async function checkOffers(db) {
  const snap = await db.collection("offers").get();
  const accsSnap = await db.collection("accounts").get();
  const accs = accsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const offers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const in3Days = new Date(today.getTime() + 3 * 86400000).toISOString().slice(0, 10);
  
  const alerts = [];

  // عروض قربت تنتهي خلال 3 أيام
  const expiringSoon = offers.filter(o => o.expiryDate && o.expiryDate >= todayStr && o.expiryDate <= in3Days);
  for (const o of expiringSoon) {
    const acc = accs.find(a => a.id === o.accountId);
    const daysLeft = Math.ceil((new Date(o.expiryDate) - today) / 86400000);
    alerts.push(`⚠️ عرض قرب ينتهي!\n📍 ${acc?.name || o.accountId}\n🎁 ${o.title}\n⏰ باقي ${daysLeft} يوم`);
  }

  // أكونتات من غير عروض من أكتر من أسبوعين
  const activeAccs = accs.filter(a => a.status === "نشط");
  for (const acc of activeAccs) {
    const accOffers = offers.filter(o => o.accountId === acc.id && o.expiryDate >= todayStr);
    if (accOffers.length === 0) {
      alerts.push(`📭 مفيش عروض!\n📍 ${acc.name}\nمن غير عروض نشطة دلوقتي`);
    }
  }

  return alerts;
}

// ══ FEATURE 3: أسئلة متكررة ══
async function checkRepeatedQuestions(db) {
  const snap = await db.collection("unanswered_questions").get();
  const questions = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(q => !q.a);
  
  // Group by similar questions
  const qMap = {};
  for (const q of questions) {
    const key = q.q?.trim().toLowerCase().slice(0, 30);
    if (!key) continue;
    if (!qMap[key]) qMap[key] = { q: q.q, accName: q.accName, count: 0 };
    qMap[key].count++;
  }
  
  const repeated = Object.values(qMap).filter(q => q.count >= 2);
  return repeated;
}

// ══ DAILY REPORT ══
async function sendDailyReport(db) {
  const today = new Date().toISOString().slice(0, 10);
  
  // Get today's unanswered questions
  const snap = await db.collection("unanswered_questions").get();
  const allQs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const todayQs = allQs.filter(q => q.createdAt?.slice(0, 10) === today);
  const answered = todayQs.filter(q => q.a);
  const unanswered = todayQs.filter(q => !q.a);

  // Sync to sheets
  const synced = await syncUnansweredToSheets(db);

  // Check offers
  const offerAlerts = await checkOffers(db);

  // Check repeated questions
  const repeated = await checkRepeatedQuestions(db);

  // Build report
  let report = `📊 <b>تقرير يومي — ${today}</b>\n\n`;
  report += `❓ أسئلة النهارده: ${todayQs.length}\n`;
  report += `✅ متجاوب: ${answered.length}\n`;
  report += `⏳ في الانتظار: ${unanswered.length}\n`;
  if (synced > 0) report += `📋 اتسجلوا في Sheets: ${synced}\n`;

  if (repeated.length > 0) {
    report += `\n🔁 <b>أسئلة بتتكرر:</b>\n`;
    for (const q of repeated.slice(0, 3)) {
      report += `• "${q.q?.slice(0, 50)}" — ${q.count} مرة (${q.accName})\n`;
    }
    report += `\n💡 ردّ عليهم من التليجرام وهيتحفظوا في البوت!`;
  }

  await sendTG(report);

  // Send offer alerts separately
  for (const alert of offerAlerts.slice(0, 5)) {
    await sendTG(alert);
  }
}

module.exports = async (req, res) => {
  // Verify it's a cron request
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).send("Unauthorized");
  }

  try {
    const db = getDB();
    await sendDailyReport(db);
    res.status(200).json({ ok: true });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};
