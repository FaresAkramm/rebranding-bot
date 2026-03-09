const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { credential } = require("firebase-admin");

// Init Firebase Admin
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

const GROQ_KEY = process.env.GROQ_KEY;
const TG_TOKEN = process.env.TG_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(s => s.trim());

async function sendTG(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

async function askGroq(systemPrompt, userMsg) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMsg }],
      max_tokens: 600,
      temperature: 0.3,
    }),
  });
  const d = await res.json();
  return d.choices?.[0]?.message?.content || "";
}

async function buildContext(db) {
  const [accsSnap, offsSnap] = await Promise.all([
    db.collection("accounts").get(),
    db.collection("offers").get(),
  ]);
  const accs = accsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const offs = offsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const now = new Date().toISOString().slice(0, 10);
  const activeOffs = offs.filter(o => !o.expiryDate || o.expiryDate >= now);

  let ctx = `أنت مساعد إداري لوكالة Rebranding. بتنفذ أوامر الأدمن مباشرة على قاعدة البيانات.
لو الأدمن طلب أكشن، ردك لازم يبدأ بـ [ACTION] وبعدين JSON على سطر لوحده.
الأكشنات المتاحة:
[ACTION]{"type":"add_offer","accountId":"ID","title":"...","description":"...","expiryDate":"YYYY-MM-DD"}
[ACTION]{"type":"edit_offer","offerId":"ID","changes":{"title":"...","expiryDate":"..."}}
[ACTION]{"type":"delete_offer","offerId":"ID"}
[ACTION]{"type":"edit_account","accountId":"ID","changes":{"fixedReply":"...","timesReply":"...","status":"نشط"}}
[ACTION]{"type":"add_reply","accountId":"ID","label":"...","text":"..."}
بعد [ACTION] اكتب رد قصير بالعربي يوضح إيه اللي عملته.

=== الأكونتات ===\n`;

  accs.forEach(a => {
    const ao = activeOffs.filter(o => o.accountId === a.id);
    ctx += `[ID:${a.id}] ${a.name} (${a.category || "—"} — ${a.status || "نشط"})\n`;
    if (ao.length) ctx += `  عروضه: ${ao.map(o => `[ID:${o.id}] ${o.title}`).join(" | ")}\n`;
  });

  return { ctx, accs, offs: activeOffs };
}

async function execAction(db, actionStr, accs, offs) {
  const parsed = JSON.parse(actionStr);
  const t = parsed.type;

  if (t === "add_offer") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) return `❌ مش لاقي الأكونت`;
    const id = "off_" + Date.now();
    await db.collection("offers").doc(id).set({
      id, accountId: parsed.accountId,
      title: parsed.title || "", description: parsed.description || "",
      content: parsed.content || "", image: "", link: "",
      expiryDate: parsed.expiryDate || "", badge: parsed.badge || "جديد",
      updatedAt: new Date().toISOString(),
    });
    return `✅ تم إضافة العرض "${parsed.title}" لـ ${acc.name}`;
  }
  if (t === "edit_offer") {
    const off = offs.find(o => o.id === parsed.offerId);
    if (!off) return `❌ مش لاقي العرض`;
    await db.collection("offers").doc(off.id).update({ ...parsed.changes, updatedAt: new Date().toISOString() });
    return `✅ تم تعديل العرض "${off.title}"`;
  }
  if (t === "delete_offer") {
    const off = offs.find(o => o.id === parsed.offerId);
    await db.collection("offers").doc(parsed.offerId).delete();
    return `🗑️ تم حذف العرض "${off?.title || parsed.offerId}"`;
  }
  if (t === "edit_account") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) return `❌ مش لاقي الأكونت`;
    await db.collection("accounts").doc(acc.id).update({ ...parsed.changes, updatedAt: new Date().toISOString() });
    return `✅ تم تعديل بيانات ${acc.name}`;
  }
  if (t === "add_reply") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) return `❌ مش لاقي الأكونت`;
    const replies = (acc.extraReplies || []).concat([{ label: parsed.label, text: parsed.text }]);
    await db.collection("accounts").doc(acc.id).update({ extraReplies: replies, updatedAt: new Date().toISOString() });
    return `✅ تم إضافة الرد "${parsed.label}" لـ ${acc.name}`;
  }
  return `❌ أكشن مش معروف: ${t}`;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("ok");

  const { message } = req.body || {};
  if (!message) return res.status(200).send("ok");

  const chatId = String(message.chat?.id);
  const text = message.text || "";

  // Auth check
  if (ADMIN_IDS.length && !ADMIN_IDS.includes(chatId)) {
    await sendTG(chatId, "⛔ مش مصرح ليك تستخدم البوت ده.");
    return res.status(200).send("ok");
  }

  try {
    const db = getDB();
    const { ctx, accs, offs } = await buildContext(db);
    const reply = await askGroq(ctx, text);

    // Detect [ACTION]
    const actionMatch = reply.match(/\[ACTION\]\s*(\{[\s\S]*?\})/);
    if (actionMatch) {
      const cleanReply = reply.replace(/\[ACTION\]\s*\{[\s\S]*?\}/, "").trim();
      if (cleanReply) await sendTG(chatId, cleanReply);
      const result = await execAction(db, actionMatch[1], accs, offs);
      await sendTG(chatId, result);
    } else {
      await sendTG(chatId, reply || "مش فاهم الطلب، حاول تاني.");
    }
  } catch (e) {
    console.error(e);
    await sendTG(chatId, "❌ خطأ: " + e.message);
  }

  res.status(200).send("ok");
};
