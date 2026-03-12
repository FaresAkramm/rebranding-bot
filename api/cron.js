const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { credential } = require("firebase-admin");
const { createSign } = require("crypto");

const SHEET_ID = "1wdBmHTmg5JdLujX-6P-MHXsoCjDwCLZWcF8BwJdlYEM";
const TG_TOKEN = process.env.TG_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
const SHEETS_CLIENT_EMAIL = process.env.SHEETS_CLIENT_EMAIL;
const SHEETS_PRIVATE_KEY = process.env.SHEETS_PRIVATE_KEY?.replace(/\\n/g, "\n");

// ══ HELPERS ══
function getEgyptDate() {
  return new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function getEgyptDatePlusDays(days) {
  return new Date(Date.now() + 2 * 60 * 60 * 1000 + days * 86400000).toISOString().slice(0, 10);
}

// ══ FIREBASE ══
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

// ══ TELEGRAM ══
async function sendTG(text) {
  for (const id of ADMIN_IDS) {
    try {
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: id, text, parse_mode: "HTML" }),
      });
    } catch (e) {
      console.error(`sendTG error for ${id}:`, e.message);
    }
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
  if (!data.access_token) throw new Error("Sheets auth failed: " + JSON.stringify(data));
  return data.access_token;
}

async function ensureSheetHeaders(token, sheetName, headers) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(sheetName)}!A1:Z1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!data.values?.[0]?.length) {
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(sheetName)}!A1:append?valueInputOption=USER_ENTERED`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ values: [headers] }),
      }
    );
  }
}

async function appendToSheet(token, sheetName, rows) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(sheetName)}!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ values: rows }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Sheets append error: ${err}`);
  }
}

// ══ SYNC UNANSWERED QUESTIONS TO SHEETS ══
async function syncUnansweredToSheets(db) {
  try {
    const token = await getSheetsToken();
    const today = getEgyptDate();

    const snap = await db.collection("unanswered_questions").get();
    const todayQs = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(q => q.createdAt?.slice(0, 10) === today);

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
  } catch (e) {
    console.error("Sheets sync error:", e.message);
    return 0;
  }
}

// ══ CHECK OFFERS EXPIRY ══
async function checkOffers(db) {
  const today = getEgyptDate();
  const in3Days = getEgyptDatePlusDays(3);

  const [offsSnap, accsSnap] = await Promise.all([
    db.collection("offers").get(),
    db.collection("accounts").get(),
  ]);

  const offers = offsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const accs = accsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const alerts = [];

  // عروض قربت تنتهي خلال 3 أيام
  const expiringSoon = offers.filter(o =>
    o.expiryDate && o.expiryDate >= today && o.expiryDate <= in3Days
  );
  for (const o of expiringSoon) {
    const acc = accs.find(a => a.id === o.accountId);
    const daysLeft = Math.ceil(
      (new Date(o.expiryDate).getTime() - new Date(today).getTime()) / 86400000
    );
    alerts.push(`⚠️ عرض قرب ينتهي!\n📍 ${acc?.name || o.accountId}\n🎁 ${o.title}\n⏰ باقي ${daysLeft} يوم`);
  }

  // أكونتات نشطة من غير عروض
  const activeAccs = accs.filter(a => a.status === "نشط");
  for (const acc of activeAccs) {
    const hasActive = offers.some(o => o.accountId === acc.id && o.expiryDate >= today);
    if (!hasActive) {
      alerts.push(`📭 مفيش عروض نشطة!\n📍 ${acc.name}`);
    }
  }

  return alerts;
}

// ══ CHECK REPEATED UNANSWERED QUESTIONS ══
async function checkRepeatedQuestions(db) {
  const snap = await db.collection("unanswered_questions").get();
  const unanswered = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(q => !q.a);

  const qMap = {};
  for (const q of unanswered) {
    const key = q.q?.trim().toLowerCase().slice(0, 30);
    if (!key) continue;
    if (!qMap[key]) qMap[key] = { q: q.q, accName: q.accName, count: 0 };
    qMap[key].count++;
  }

  return Object.values(qMap).filter(q => q.count >= 2);
}

// ══ DAILY REPORT ══
async function sendDailyReport(db) {
  const today = getEgyptDate();

  const snap = await db.collection("unanswered_questions").get();
  const allQs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const todayQs = allQs.filter(q => q.createdAt?.slice(0, 10) === today);
  const answered = todayQs.filter(q => q.a);
  const unanswered = todayQs.filter(q => !q.a);

  const [synced, offerAlerts, repeated] = await Promise.all([
    syncUnansweredToSheets(db),
    checkOffers(db),
    checkRepeatedQuestions(db),
  ]);

  // ── Main report ──
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

  // ── Offer alerts (separate messages) ──
  for (const alert of offerAlerts.slice(0, 5)) {
    await sendTG(alert);
  }
}

// ══ VERCEL HANDLER ══
module.exports = async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).send("Unauthorized");
  }

  try {
    const db = getDB();
    await sendDailyReport(db);
    return res.status(200).json({ ok: true, date: getEgyptDate() });
  } catch (e) {
    console.error("Cron error:", e);
    return res.status(500).json({ error: e.message });
  }
};
