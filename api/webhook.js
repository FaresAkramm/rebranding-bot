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

// In-memory conversation history per chat (resets on cold start)
const chatHistory = {};

async function sendTG(chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const d = await res.json();
  return d.result?.message_id;
}

async function askGroq(systemPrompt, history) {
  const messages = [{ role: "system", content: systemPrompt }, ...history];
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages,
      max_tokens: 700,
      temperature: 0,
    }),
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

  let ctx = `أنت مساعد إداري دقيق جداً لوكالة Rebranding.
قواعد صارمة:
1. لو الأدمن طلب أكشن، لازم تأكد اسم الأكونت الصح من القائمة أولاً.
2. لو في أكونتات بنفس الاسم أو قريبة، اسأل الأدمن يأكدلك.
3. استخدم الـ ID الصح بالظبط من القائمة — لا تخترع ID.
4. لو مش متأكد، اسأل بدل ما تنفذ غلط.
5. بعد الأكشن اكتب رد قصير بالعربي يوضح اللي اتعمل.

الأكشنات المتاحة (استخدم [ACTION] وبعدين JSON على نفس السطر):
[ACTION]{"type":"add_offer","accountId":"ID_HERE","title":"...","description":"...","content":"...","expiryDate":"YYYY-MM-DD","badge":"جديد"}
[ACTION]{"type":"edit_offer","offerId":"ID_HERE","changes":{"title":"...","description":"...","expiryDate":"..."}}
[ACTION]{"type":"delete_offer","offerId":"ID_HERE"}
[ACTION]{"type":"edit_account","accountId":"ID_HERE","changes":{"fixedReply":"...","timesReply":"...","contactReply":"...","status":"نشط"}}
[ACTION]{"type":"add_reply","accountId":"ID_HERE","label":"...","text":"..."}

=== قائمة الأكونتات والعروض ===\n`;

  accs.forEach(a => {
    const ao = activeOffs.filter(o => o.accountId === a.id);
    ctx += `• ${a.name} | ID: ${a.id} | ${a.category || "—"} | ${a.status || "نشط"}\n`;
    if (ao.length) {
      ao.forEach(o => {
        ctx += `  ↳ عرض: ${o.title} | ID: ${o.id}${o.expiryDate ? ` | ينتهي: ${o.expiryDate}` : ""}\n`;
      });
    }
  });

  return { ctx, accs, offs: activeOffs };
}

async function execAction(db, actionStr, accs, offs) {
  const parsed = JSON.parse(actionStr);
  const t = parsed.type;

  if (t === "add_offer") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) return `❌ ID الأكونت غلط: ${parsed.accountId}\nالأكونتات المتاحة:\n${accs.map(a=>`• ${a.name}: ${a.id}`).join("\n")}`;
    const id = "off_" + Date.now();
    await db.collection("offers").doc(id).set({
      id, accountId: parsed.accountId,
      title: parsed.title || "", description: parsed.description || "",
      content: parsed.content || "", image: "", link: "",
      expiryDate: parsed.expiryDate || "", badge: parsed.badge || "جديد",
      updatedAt: new Date().toISOString(),
    });
    return `✅ تم إضافة العرض\nالاسم: ${parsed.title}\nالأكونت: ${acc.name}`;
  }
  if (t === "edit_offer") {
    const off = offs.find(o => o.id === parsed.offerId);
    if (!off) return `❌ ID العرض غلط: ${parsed.offerId}\nالعروض المتاحة:\n${offs.map(o=>`• ${o.title}: ${o.id}`).join("\n")}`;
    await db.collection("offers").doc(off.id).update({ ...parsed.changes, updatedAt: new Date().toISOString() });
    return `✅ تم تعديل العرض: ${off.title}`;
  }
  if (t === "delete_offer") {
    const off = offs.find(o => o.id === parsed.offerId);
    if (!off) return `❌ ID العرض غلط: ${parsed.offerId}`;
    await db.collection("offers").doc(parsed.offerId).delete();
    return `🗑️ تم حذف العرض: ${off.title}`;
  }
  if (t === "edit_account") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) return `❌ ID الأكونت غلط: ${parsed.accountId}`;
    await db.collection("accounts").doc(acc.id).update({ ...parsed.changes, updatedAt: new Date().toISOString() });
    return `✅ تم تعديل: ${acc.name}`;
  }
  if (t === "add_reply") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) return `❌ ID الأكونت غلط: ${parsed.accountId}`;
    const replies = (acc.extraReplies || []).concat([{ label: parsed.label, text: parsed.text }]);
    await db.collection("accounts").doc(acc.id).update({ extraReplies: replies, updatedAt: new Date().toISOString() });
    return `✅ تم إضافة الرد "${parsed.label}" لـ ${acc.name}`;
  }
  return `❌ أكشن مش معروف: ${t}`;
}

async function handleReply(db, replyText, originalText, accs) {
  const idMatch = originalText.match(/\[ID:(uq_\d+)\]/);
  if (!idMatch) return false;
  const qId = idMatch[1];
  const qDoc = await db.collection("unanswered_questions").doc(qId).get();
  if (!qDoc.exists) return false;
  const qData = qDoc.data();
  await db.collection("unanswered_questions").doc(qId).update({ a: replyText });

  // Use accId directly if available - most reliable
  const aidMatch = originalText.match(/\[AID:([^\]]+)\]/);
  const accId = aidMatch ? aidMatch[1] : null;

  let matched = null;
  if (accId) {
    matched = accs.find(a => a.id === accId);
  }
  // Fallback to name matching only if no accId
  if (!matched) {
    matched = accs.find(a => a.name === qData.accName);
  }

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

  // Reset history command
  if (text === "/start" || text === "/reset") {
    chatHistory[chatId] = [];
    await sendTG(chatId, "👋 أهلاً! قولي إيه اللي عايزه.\nمثال: أضف عرض لـ [اسم الأكونت]");
    return res.status(200).send("ok");
  }

  try {
    const db = getDB();

    // Handle reply to unanswered question
    if (message.reply_to_message) {
      const originalText = message.reply_to_message.text || "";
      const accsSnap = await db.collection("accounts").get();
      const accs = accsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const savedQ = await handleReply(db, text, originalText, accs);
      if (savedQ) {
        await sendTG(chatId, `✅ تم حفظ الإجابة في تدريب البوت!\n\nالأكونت: ${savedQ.accName}\nالسؤال: ${savedQ.q}\nالإجابة: ${text}`);
        return res.status(200).send("ok");
      }
    }

    // Build context + history
    const { ctx, accs, offs } = await buildAdminContext(db);
    if (!chatHistory[chatId]) chatHistory[chatId] = [];

    // Add user message to history
    chatHistory[chatId].push({ role: "user", content: text });

    // Keep last 6 messages only
    if (chatHistory[chatId].length > 6) chatHistory[chatId] = chatHistory[chatId].slice(-6);

    const reply = await askGroq(ctx, chatHistory[chatId]);

    // Add assistant reply to history
    chatHistory[chatId].push({ role: "assistant", content: reply });

    // Detect [ACTION]
    const actionMatch = reply.match(/\[ACTION\]\s*(\{[\s\S]*?\})/);
    if (actionMatch) {
      const cleanReply = reply.replace(/\[ACTION\]\s*\{[\s\S]*?\}/, "").trim();
      if (cleanReply) await sendTG(chatId, cleanReply);
      try {
        const result = await execAction(db, actionMatch[1], accs, offs);
        await sendTG(chatId, result);
      } catch(e) {
        await sendTG(chatId, "❌ خطأ في التنفيذ: " + e.message);
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
