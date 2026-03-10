const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { credential } = require("firebase-admin");

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
const chatHistory = {};

async function sendTG(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function askGroq(systemPrompt, history) {
  const messages = [{ role: "system", content: systemPrompt }, ...history];
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages, max_tokens: 700, temperature: 0 }),
  });
  const d = await res.json();
  return d.choices?.[0]?.message?.content || "";
}

async function buildAdminContext(db) {
  const [accsSnap, offsSnap] = await Promise.all([
    db.collection("accounts").get(),
    db.collection("offers").get(),
  ]);
  const accs = accsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const offs = offsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const now = new Date().toISOString().slice(0, 10);
  const activeOffs = offs.filter(o => !o.expiryDate || o.expiryDate >= now);

  let ctx = `أنت مساعد إداري دقيق لوكالة Rebranding.
قواعد:
1. لو الأدمن طلب أكشن، استخدم [ACTION] وبعدين JSON.
2. استخدم الـ ID الصح من القائمة بالظبط.
3. لو مش متأكد من الأكونت، اسأل.

الأكشنات:
[ACTION]{"type":"add_offer","accountId":"ID","title":"...","description":"...","content":"...","expiryDate":"YYYY-MM-DD","badge":"جديد"}
[ACTION]{"type":"edit_offer","offerId":"ID","changes":{"title":"...","expiryDate":"..."}}
[ACTION]{"type":"delete_offer","offerId":"ID"}
[ACTION]{"type":"edit_account","accountId":"ID","changes":{"fixedReply":"...","timesReply":"...","contactReply":"...","status":"نشط"}}
[ACTION]{"type":"add_reply","accountId":"ID","label":"...","text":"..."}
[ACTION]{"type":"add_info","accountId":"ID","question":"...","answer":"..."}

=== الأكونتات ===\n`;

  accs.forEach(a => {
    const ao = activeOffs.filter(o => o.accountId === a.id);
    ctx += `• ${a.name} | ID: ${a.id}\n`;
    if (ao.length) ao.forEach(o => { ctx += `  ↳ ${o.title} | ID: ${o.id}\n`; });
  });

  return { ctx, accs, offs: activeOffs };
}

async function execAction(db, actionStr, accs, offs) {
  const parsed = JSON.parse(actionStr);
  const t = parsed.type;
  if (t === "add_offer") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) return `❌ ID غلط: ${parsed.accountId}`;
    const id = "off_" + Date.now();
    await db.collection("offers").doc(id).set({ id, accountId: parsed.accountId, title: parsed.title||"", description: parsed.description||"", content: parsed.content||"", image:"", link:"", expiryDate: parsed.expiryDate||"", badge: parsed.badge||"جديد", updatedAt: new Date().toISOString() });
    return `✅ تم إضافة العرض: ${parsed.title}\nالأكونت: ${acc.name}`;
  }
  if (t === "edit_offer") {
    const off = offs.find(o => o.id === parsed.offerId);
    if (!off) return `❌ ID غلط: ${parsed.offerId}`;
    await db.collection("offers").doc(off.id).update({ ...parsed.changes, updatedAt: new Date().toISOString() });
    return `✅ تم تعديل: ${off.title}`;
  }
  if (t === "delete_offer") {
    const off = offs.find(o => o.id === parsed.offerId);
    if (!off) return `❌ ID غلط: ${parsed.offerId}`;
    await db.collection("offers").doc(parsed.offerId).delete();
    return `🗑️ تم حذف: ${off.title}`;
  }
  if (t === "edit_account") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) return `❌ ID غلط: ${parsed.accountId}`;
    await db.collection("accounts").doc(acc.id).update({ ...parsed.changes, updatedAt: new Date().toISOString() });
    return `✅ تم تعديل: ${acc.name}`;
  }
  if (t === "add_reply") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) return `❌ ID غلط: ${parsed.accountId}`;
    const replies = (acc.extraReplies || []).concat([{ label: parsed.label, text: parsed.text }]);
    await db.collection("accounts").doc(acc.id).update({ extraReplies: replies, updatedAt: new Date().toISOString() });
    return `✅ تم إضافة الرد لـ ${acc.name}`;
  }
  if (t === "add_info") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) return `❌ ID غلط: ${parsed.accountId}`;
    const existing = acc.trainedQA || [];
    const isDup = existing.find(x => x.q && x.q.trim() === (parsed.question||"").trim());
    const newQA = isDup
      ? existing.map(x => x.q.trim() === parsed.question.trim() ? {q:x.q, a:parsed.answer} : x)
      : [...existing, {q: parsed.question, a: parsed.answer}];
    await db.collection("accounts").doc(acc.id).update({ trainedQA: newQA, updatedAt: new Date().toISOString() });
    return `✅ تم إضافة المعلومة لـ ${acc.name}
السؤال: ${parsed.question}
الإجابة: ${parsed.answer}`;
  }
  return `❌ أكشن مش معروف: ${t}`;
}

async function handleReply(db, replyText, originalText, accs) {
  // Extract question ID
  const idMatch = originalText.match(/\[ID:(uq_\d+)\]/);
  if (!idMatch) return false;
  const qId = idMatch[1];

  const qDoc = await db.collection("unanswered_questions").doc(qId).get();
  if (!qDoc.exists) return false;
  const qData = qDoc.data();

  await db.collection("unanswered_questions").doc(qId).update({ a: replyText });

  // Extract account ID directly - most reliable
  const aidMatch = originalText.match(/\[AID:([^\]]+)\]/);
  const accId = aidMatch ? aidMatch[1].trim() : null;

  let matched = accId ? accs.find(a => a.id === accId) : null;
  if (!matched) matched = accs.find(a => a.name === qData.accName);

  if (matched) {
    const existing = matched.trainedQA || [];
    const isDup = existing.find(x => x.q.trim() === qData.q.trim());
    const newQA = isDup
      ? existing.map(x => x.q.trim() === qData.q.trim() ? { q: x.q, a: replyText } : x)
      : [...existing, { q: qData.q, a: replyText }];
    await db.collection("accounts").doc(matched.id).update({ trainedQA: newQA, updatedAt: new Date().toISOString() });
    return { q: qData.q, accName: matched.name };
  }
  return { q: qData.q, accName: qData.accName };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("ok");
  const { message } = req.body || {};
  if (!message) return res.status(200).send("ok");

  const chatId = String(message.chat?.id);
  const text = (message.text || "").trim();

  if (ADMIN_IDS.length && !ADMIN_IDS.includes(chatId)) {
    await sendTG(chatId, "⛔ مش مصرح ليك.");
    return res.status(200).send("ok");
  }

  if (text === "/start" || text === "/reset") {
    chatHistory[chatId] = [];
    await sendTG(chatId, "👋 أهلاً! قولي إيه اللي عايزه.");
    return res.status(200).send("ok");
  }

  try {
    const db = getDB();

    // Handle reply to unanswered question
    if (message.reply_to_message) {
      const originalText = message.reply_to_message.text || "";
      if (originalText.includes("[ID:uq_")) {
        const accsSnap = await db.collection("accounts").get();
        const accs = accsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        const result = await handleReply(db, text, originalText, accs);
        if (result) {
          await sendTG(chatId, `✅ تم حفظ الإجابة!\n\nالأكونت: ${result.accName}\nالسؤال: ${result.q}\nالإجابة: ${text}`);
          return res.status(200).send("ok");
        }
      }
    }

    const { ctx, accs, offs } = await buildAdminContext(db);
    if (!chatHistory[chatId]) chatHistory[chatId] = [];
    chatHistory[chatId].push({ role: "user", content: text });
    if (chatHistory[chatId].length > 6) chatHistory[chatId] = chatHistory[chatId].slice(-6);

    const reply = await askGroq(ctx, chatHistory[chatId]);
    chatHistory[chatId].push({ role: "assistant", content: reply });

    const actionMatch = reply.match(/\[ACTION\]\s*(\{[\s\S]*?\})/);
    if (actionMatch) {
      const cleanReply = reply.replace(/\[ACTION\]\s*\{[\s\S]*?\}/, "").trim();
      if (cleanReply) await sendTG(chatId, cleanReply);
      try {
        const result = await execAction(db, actionMatch[1], accs, offs);
        await sendTG(chatId, result);
      } catch(e) {
        await sendTG(chatId, "❌ خطأ: " + e.message);
      }
    } else {
      await sendTG(chatId, reply || "مش فاهم، حاول تاني.");
    }
  } catch (e) {
    console.error(e);
    await sendTG(chatId, "❌ خطأ: " + e.message);
  }

  res.status(200).send("ok");
};
