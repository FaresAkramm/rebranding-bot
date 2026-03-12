const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { credential } = require("firebase-admin");

// ══ HELPERS ══
function getEgyptDate() {
  const egyptTime = new Date(Date.now() + 2 * 60 * 60 * 1000);
  return egyptTime.toISOString().slice(0, 10);
}

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
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean);

// In-memory chat history (resets on cold start — acceptable for Vercel)
const chatHistory = {};

// ══ TELEGRAM ══
async function sendTG(chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
  } catch (e) {
    console.error("sendTG error:", e.message);
  }
}

// ══ GROQ ══
async function askGroq(systemPrompt, history) {
  const messages = [{ role: "system", content: systemPrompt }, ...history];
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({
      model: "meta-llama/llama-4-maverick-17b-128e-instruct",
      messages,
      max_tokens: 700,
      temperature: 0,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq error ${res.status}: ${err}`);
  }
  const d = await res.json();
  return d.choices?.[0]?.message?.content?.trim() || "";
}

// ══ BUILD SYSTEM PROMPT ══
async function buildAdminContext(db) {
  const today = getEgyptDate();

  const [accsSnap, offsSnap] = await Promise.all([
    db.collection("accounts").get(),
    db.collection("offers").get(),
  ]);

  const accs = accsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const allOffs = offsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const activeOffs = allOffs.filter(o => !o.expiryDate || o.expiryDate >= today);

  let ctx = `أنت مساعد إداري لوكالة Rebranding. بتنفذ أوامر الأدمن بدقة.
النهارده: ${today}

قواعد صارمة جداً:
1. لو الأدمن بيرد على سؤال زائر (زي "اه" أو "لأ") — مش هتعمل [ACTION] خالص، بس هتقوله "✅ تم حفظ الإجابة" وتوضحها.
2. [ACTION] بتستخدمه فقط لو الأدمن طلب صراحة إضافة أو تعديل أو حذف.
3. لو الأدمن قالك "ضيف عرض" لازم تسأله عن تاريخ الانتهاء لو مش قاله.
4. expiryDate لازم تكون في المستقبل (بعد ${today}) — مش في الماضي.
5. استخدم الـ ID الصح من القائمة بالظبط.
6. لو مش متأكد من الأكونت، اسأل.

الأكشنات المتاحة (استخدم [ACTION] وبعدين JSON على سطر واحد):
[ACTION]{"type":"add_offer","accountId":"ID","title":"...","description":"...","content":"...","expiryDate":"YYYY-MM-DD","badge":"جديد"}
[ACTION]{"type":"edit_offer","offerId":"ID","changes":{"title":"...","expiryDate":"..."}}
[ACTION]{"type":"delete_offer","offerId":"ID"}
[ACTION]{"type":"edit_account","accountId":"ID","changes":{"fixedReply":"...","timesReply":"...","contactReply":"...","status":"نشط"}}
[ACTION]{"type":"add_account","name":"...","category":"...","description":"...","status":"نشط"}
[ACTION]{"type":"add_reply","accountId":"ID","label":"...","text":"..."}
[ACTION]{"type":"add_info","accountId":"ID","question":"...","answer":"..."}

تذكر دايماً:
• "أضف معلومة" أو "علّم البوت" = add_info
• "أضف رد" أو "رد جاهز" = add_reply
• لو الأدمن بيجاوب على سؤال زائر (رسالة فيها [ID:uq_]) = الكود بيتولاها تلقائي، متستخدمش [ACTION]

=== الأكونتات ===
`;

  accs.forEach(a => {
    const ao = activeOffs.filter(o => o.accountId === a.id);
    ctx += `• ${a.name} | ID: ${a.id} | ${a.status || "نشط"}\n`;
    ao.forEach(o => {
      ctx += `  ↳ عرض: ${o.title} | ID: ${o.id} | ينتهي: ${o.expiryDate || "مش محدد"}\n`;
    });
  });

  return { ctx, accs, activeOffs, allOffs, today };
}

// ══ EXECUTE ACTION ══
async function execAction(db, actionStr, accs, activeOffs, today) {
  let parsed;
  try {
    parsed = JSON.parse(actionStr);
  } catch (e) {
    return `❌ JSON غلط: ${e.message}\n${actionStr}`;
  }

  const t = parsed.type;

  if (t === "add_offer") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) {
      return `❌ ID غلط: ${parsed.accountId}\nالأكونتات المتاحة:\n${accs.map(a => `• ${a.name}: ${a.id}`).join("\n")}`;
    }
    // Auto-fix expiry date if missing or in the past
    const oneYearLater = new Date(Date.now() + 2 * 60 * 60 * 1000);
    oneYearLater.setFullYear(oneYearLater.getFullYear() + 1);
    const defaultExpiry = oneYearLater.toISOString().slice(0, 10);
    const expiry = (parsed.expiryDate && String(parsed.expiryDate).trim() && parsed.expiryDate >= today)
      ? parsed.expiryDate
      : defaultExpiry;
    const wasFixed = !parsed.expiryDate || parsed.expiryDate < today;

    const id = "off_" + Date.now();
    await db.collection("offers").doc(id).set({
      id,
      accountId: parsed.accountId,
      title: parsed.title || "",
      description: parsed.description || "",
      content: parsed.content || "",
      image: "",
      link: "",
      expiryDate: expiry,
      badge: parsed.badge || "جديد",
      updatedAt: new Date().toISOString(),
    });
    return `✅ تم إضافة العرض\nالاسم: ${parsed.title}\nالأكونت: ${acc.name}\nينتهي: ${expiry}${wasFixed ? " (تم تحديده تلقائي)" : ""}`;
  }

  if (t === "edit_offer") {
    const off = activeOffs.find(o => o.id === parsed.offerId);
    if (!off) return `❌ ID غلط: ${parsed.offerId}`;
    if (parsed.changes?.expiryDate && parsed.changes.expiryDate < today) {
      return `❌ تاريخ الانتهاء في الماضي! النهارده: ${today}`;
    }
    await db.collection("offers").doc(off.id).update({
      ...parsed.changes,
      updatedAt: new Date().toISOString(),
    });
    return `✅ تم تعديل: ${off.title}`;
  }

  if (t === "delete_offer") {
    const off = activeOffs.find(o => o.id === parsed.offerId);
    if (!off) return `❌ ID غلط: ${parsed.offerId}`;
    await db.collection("offers").doc(parsed.offerId).delete();
    return `🗑️ تم حذف: ${off.title}`;
  }

  if (t === "edit_account") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) return `❌ ID غلط: ${parsed.accountId}`;
    await db.collection("accounts").doc(acc.id).update({
      ...parsed.changes,
      updatedAt: new Date().toISOString(),
    });
    return `✅ تم تعديل: ${acc.name}`;
  }

  if (t === "add_reply") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) return `❌ ID غلط: ${parsed.accountId}`;
    const replies = [...(acc.extraReplies || []), { label: parsed.label, text: parsed.text }];
    await db.collection("accounts").doc(acc.id).update({
      extraReplies: replies,
      updatedAt: new Date().toISOString(),
    });
    return `✅ تم إضافة الرد لـ ${acc.name}`;
  }

  if (t === "add_account") {
    const id = "acc_" + Date.now();
    await db.collection("accounts").doc(id).set({
      id,
      name: parsed.name || "",
      category: parsed.category || "عام",
      description: parsed.description || "",
      status: parsed.status || "نشط",
      avatar: "",
      coverImage: "",
      tags: [],
      links: [],
      extraReplies: [],
      galleryImages: [],
      trainedQA: [],
      fixedReply: "",
      timesReply: "",
      contactReply: "",
      pinned: false,
      joinedDate: getEgyptDate(),
      updatedAt: new Date().toISOString(),
    });
    return `✅ تم إضافة الأكونت\nالاسم: ${parsed.name}\nالكاتيجوري: ${parsed.category || "عام"}\n\nتقدر تضيف تفاصيل أكتر من السايت ✏️`;
  }

  if (t === "add_info") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) return `❌ ID غلط: ${parsed.accountId}`;
    const existing = acc.trainedQA || [];
    const isDup = existing.find(x => x.q?.trim() === (parsed.question || "").trim());
    const newQA = isDup
      ? existing.map(x => x.q?.trim() === parsed.question?.trim() ? { q: x.q, a: parsed.answer } : x)
      : [...existing, { q: parsed.question, a: parsed.answer }];
    await db.collection("accounts").doc(acc.id).update({
      trainedQA: newQA,
      updatedAt: new Date().toISOString(),
    });
    return `✅ تم حفظ المعلومة في تدريب البوت\nالأكونت: ${acc.name}\nالسؤال: ${parsed.question}\nالإجابة: ${parsed.answer}`;
  }

  return `❌ أكشن مش معروف: ${t}`;
}

// ══ HANDLE REPLY TO UNANSWERED QUESTION ══
async function handleReply(db, replyText, originalText, accs) {
  const idMatch = originalText.match(/\[ID:(uq_\d+)\]/);
  if (!idMatch) return false;

  const qId = idMatch[1];
  const qDoc = await db.collection("unanswered_questions").doc(qId).get();
  if (!qDoc.exists) return false;

  const qData = qDoc.data();
  await db.collection("unanswered_questions").doc(qId).update({ a: replyText });

  // Try to match account by ID first, then by name
  const aidMatch = originalText.match(/\[AID:([^\]]+)\]/);
  const accId = aidMatch ? aidMatch[1].trim() : null;
  const matched = (accId ? accs.find(a => a.id === accId) : null)
    || accs.find(a => a.name === qData.accName);

  if (matched) {
    const existing = matched.trainedQA || [];
    const isDup = existing.find(x => x.q?.trim() === qData.q?.trim());
    const newQA = isDup
      ? existing.map(x => x.q?.trim() === qData.q?.trim() ? { q: x.q, a: replyText } : x)
      : [...existing, { q: qData.q, a: replyText }];
    await db.collection("accounts").doc(matched.id).update({
      trainedQA: newQA,
      updatedAt: new Date().toISOString(),
    });
    return { q: qData.q, accName: matched.name };
  }

  return { q: qData.q, accName: qData.accName };
}

// ══ MAIN HANDLER ══
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("ok");

  const { message } = req.body || {};
  if (!message) return res.status(200).send("ok");

  const chatId = String(message.chat?.id);
  const text = (message.text || "").trim();
  if (!text) return res.status(200).send("ok");

  // Auth check
  if (ADMIN_IDS.length && !ADMIN_IDS.includes(chatId)) {
    await sendTG(chatId, "⛔ مش مصرح ليك.");
    return res.status(200).send("ok");
  }

  // Reset command
  if (text === "/start" || text === "/reset") {
    chatHistory[chatId] = [];
    await sendTG(chatId, "👋 أهلاً! قولي إيه اللي عايزه.");
    return res.status(200).send("ok");
  }

  try {
    const db = getDB();

    // ══ HANDLE REPLY TO UNANSWERED QUESTION (before AI) ══
    if (message.reply_to_message) {
      const origText = message.reply_to_message.text || "";
      if (origText.includes("[ID:uq_")) {
        const accsSnap = await db.collection("accounts").get();
        const accs = accsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        const result = await handleReply(db, text, origText, accs);
        if (result) {
          await sendTG(chatId, `✅ تم حفظ الإجابة في تدريب البوت!\n\nالأكونت: ${result.accName}\nالسؤال: ${result.q}\nالإجابة: ${text}`);
          return res.status(200).send("ok");
        }
      }
    }

    // ══ NORMAL ADMIN COMMAND ══
    const { ctx, accs, activeOffs, today } = await buildAdminContext(db);

    if (!chatHistory[chatId]) chatHistory[chatId] = [];
    chatHistory[chatId].push({ role: "user", content: text });
    // Keep last 6 messages only
    if (chatHistory[chatId].length > 6) chatHistory[chatId] = chatHistory[chatId].slice(-6);

    const reply = await askGroq(ctx, chatHistory[chatId]);
    chatHistory[chatId].push({ role: "assistant", content: reply });

    // Check for action
    const actionMatch = reply.match(/\[ACTION\]\s*(\{[\s\S]*?\})/);
    if (actionMatch) {
      const cleanReply = reply.replace(/\[ACTION\]\s*\{[\s\S]*?\}/, "").trim();
      if (cleanReply) await sendTG(chatId, cleanReply);
      try {
        const result = await execAction(db, actionMatch[1], accs, activeOffs, today);
        await sendTG(chatId, result);
      } catch (e) {
        await sendTG(chatId, "❌ خطأ في التنفيذ: " + e.message);
      }
    } else {
      await sendTG(chatId, reply || "مش فاهم، حاول تاني.");
    }

  } catch (e) {
    console.error("Webhook error:", e);
    await sendTG(chatId, "❌ خطأ: " + e.message);
  }

  return res.status(200).send("ok");
};
