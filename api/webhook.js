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

async function logActivity(db, type, label, detail) {
  try {
    const id = "act_" + Date.now();
    await db.collection("activity_log").doc(id).set({
      id, type, label, detail: detail || "",
      source: "telegram",
      createdAt: new Date().toISOString()
    });
  } catch(e) {}
}
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
    body: JSON.stringify({ model: "meta-llama/llama-4-maverick-17b-128e-instruct", messages, max_tokens: 700, temperature: 0 }),
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
  // Egypt timezone UTC+2
  const nowDate = new Date();
  const egyptOffset = 2 * 60;
  const egyptTime = new Date(nowDate.getTime() + egyptOffset * 60 * 1000);
  const today = egyptTime.toISOString().slice(0, 10);
  console.log("Today:", today);
  const activeOffs = offs.filter(o => !o.expiryDate || o.expiryDate >= today);

  let ctx = `أنت مساعد إداري لوكالة Rebranding. بتنفذ أوامر الأدمن بدقة.
النهارده: ${today}

قواعد صارمة جداً:
1. لو الأدمن بيرد على سؤال زائر — مش هتعمل [ACTION]، بس قوله "✅ تم حفظ الإجابة".
2. [ACTION] بتستخدمه فقط لو الأدمن طلب صراحة إضافة أو تعديل أو حذف.
3. لو الأدمن قالك "ضيف عرض" لازم تسأله عن تاريخ الانتهاء لو مش قاله.
4. expiryDate لازم تكون في المستقبل (بعد ${today}).
5. استخدم الـ ID الصح من القائمة بالظبط.
6. لو مش متأكد من الأكونت، اسأل.

🔑 ترجمة المصطلحات:
- "الرد الثابت" / "fixed reply" / "الرسالة الترحيبية" = fixedReply
- "مسح/حذف/امسح الرد الثابت" = edit_account + fixedReply: ""
- "المواعيد" / "أوقات العمل" = timesReply
- "التواصل" / "رقم الواتساب" / "الكونتاكت" = contactReply
- "الردود الإضافية" / "ردود اختياري" / "أزرار الكوبي" = extraReplies (add_reply / delete_reply)
- "صور المنيو" / "الألبوم" / "الصور" = galleryImages (delete_image)
- "باسورد" / "كلمة المرور" / "password" = change_password
- الباسورد الجديد = الكلمة أو الرقم بعد "لـ" أو "خليه" أو "to" أو "يكون"

الأكشنات (استخدم [ACTION] وبعدين JSON):

--- العروض ---
[ACTION]{"type":"add_offer","accountId":"ID","title":"...","description":"...","content":"...","expiryDate":"YYYY-MM-DD","badge":"جديد"}
[ACTION]{"type":"edit_offer","offerId":"ID","changes":{"title":"...","expiryDate":"..."}}
[ACTION]{"type":"delete_offer","offerId":"ID"}

--- الأكونتات ---
[ACTION]{"type":"add_account","name":"...","category":"...","description":"...","status":"نشط"}
[ACTION]{"type":"delete_account","accountId":"ID"}
[ACTION]{"type":"edit_account","accountId":"ID","changes":{"name":"...","category":"...","description":"...","fixedReply":"...","timesReply":"...","contactReply":"...","status":"نشط"}}

⚠️ تعديل حقول الأكونت:
- "الرد الثابت" أو "fixed reply" أو "الرسالة الترحيبية" = fixedReply
- لمسح الرد الثابت: [ACTION]{"type":"edit_account","accountId":"ID","changes":{"fixedReply":""}}
- "مواعيد العمل" أو "الأوقات" = timesReply
- لمسح المواعيد: [ACTION]{"type":"edit_account","accountId":"ID","changes":{"timesReply":""}}
- "التواصل" أو "رقم الواتساب" = contactReply
- لمسح التواصل: [ACTION]{"type":"edit_account","accountId":"ID","changes":{"contactReply":""}}

--- الردود الجاهزة (extraReplies = أزرار الكوبي في الكارد) ---
[ACTION]{"type":"add_reply","accountId":"ID","label":"اسم الزرار","text":"نص الرد"}
[ACTION]{"type":"delete_reply","accountId":"ID","label":"اسم الزرار"}

--- تدريب البوت (trainedQA = أسئلة وأجوبة البوت) ---
[ACTION]{"type":"add_info","accountId":"ID","question":"...","answer":"..."}
[ACTION]{"type":"delete_info","accountId":"ID","question":"..."}

--- الصور ---
[ACTION]{"type":"delete_image","accountId":"ID","imageUrl":"..."}

--- الباسورد ---
[ACTION]{"type":"change_password","newPassword":"..."}
⚠️ أي جملة فيها "باسورد" أو "كلمة المرور" أو "password" مع رقم أو كلمة = change_password
أمثلة: "غير الباسورد لـ 1234" / "عدل باسورد الأدمن خليه abc" / "change password to xyz"
الباسورد الجديد = أي كلمة أو رقم بعد "لـ" أو "خليه" أو "to"

مهم: "أضف معلومة" أو "علّم البوت" = add_info دايماً.
مهم: "أضف رد" أو "رد جاهز" = add_reply دايماً.
مهم: لو الأدمن بيجاوب على سؤال زائر (رسالة فيها [ID:uq_]) = مش add_info ولا add_reply، الكود هيتولاها تلقائي.

=== أمثلة على أوامر شائعة ===
"ضيف رد في مندي السلطان اسمه حجز الصالة المحتوي ده حجز الصالة 01127592420"
→ add_reply للأكونت ده بـ label="حجز الصالة" وtext="حجز الصالة 01127592420"

"غير باسورد الادمن الي 2388" أو "غير الباسورد خليه 2388"
→ change_password بـ newPassword="2388"

"امسح الرد الثابت من مندي السلطان"
→ edit_account + changes: {fixedReply:""}

"ضيف عرض في شيخ البلد اسمه خصم 20%"
→ add_offer — اسأل عن تاريخ الانتهاء لو مش موجود

"علم البوت ان مندي السلطان عنده توصيل"
→ add_info بـ question="في توصيل؟" answer="أيوه عندنا توصيل"

=== الأكونتات ===\n`;

  accs.forEach(a => {
    const ao = activeOffs.filter(o => o.accountId === a.id);
    ctx += `• ${a.name} | ID: ${a.id} | ${a.status || "نشط"}\n`;
    if (ao.length) ao.forEach(o => {
      ctx += `  ↳ عرض: ${o.title} | ID: ${o.id} | ينتهي: ${o.expiryDate || "مش محدد"}\n`;
    });
  });

  return { ctx, accs, offs: activeOffs, allOffs: offs };
}

async function execAction(db, actionStr, accs, offs) {
  const parsed = JSON.parse(actionStr);
  const t = parsed.type;
  // Egypt timezone UTC+2
  const now = new Date();
  const egyptOffset = 2 * 60;
  const egyptTime = new Date(nowDate.getTime() + egyptOffset * 60 * 1000);
  const today = egyptTime.toISOString().slice(0, 10);
  console.log("Today:", today);
  const activeOffs = offs.filter(o => !o.expiryDate || o.expiryDate >= today);

  if (t === "add_offer") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) return `❌ ID غلط: ${parsed.accountId}\nالأكونتات:\n${accs.map(a=>`• ${a.name}: ${a.id}`).join("\n")}`;
    // Fix expiry date: if missing or in the past, set 1 year from now
    const oneYearLater = new Date(egyptTime); oneYearLater.setFullYear(oneYearLater.getFullYear()+1);
    const defaultExpiry = oneYearLater.toISOString().slice(0,10);
    // Force default if no date, empty, or past date
    const expiry = (parsed.expiryDate && String(parsed.expiryDate).trim() && parsed.expiryDate >= today) 
      ? parsed.expiryDate 
      : defaultExpiry;
    const id = "off_" + Date.now();
    await db.collection("offers").doc(id).set({
      id, accountId: parsed.accountId,
      title: parsed.title || "", description: parsed.description || "",
      content: parsed.content || "", image: "", link: "",
      expiryDate: expiry, badge: parsed.badge || "جديد",
      updatedAt: new Date().toISOString(),
    });
    const wasFixed = (!parsed.expiryDate || parsed.expiryDate < today);
    return `✅ تم إضافة العرض\nالاسم: ${parsed.title}\nالأكونت: ${acc.name}\nينتهي: ${expiry}${wasFixed ? " (تم تحديده تلقائي)" : ""}`;
  }
  if (t === "edit_offer") {
    const off = offs.find(o => o.id === parsed.offerId);
    if (!off) return `❌ ID غلط: ${parsed.offerId}`;
    if (parsed.changes?.expiryDate && parsed.changes.expiryDate < today) {
      return `❌ تاريخ الانتهاء في الماضي! النهارده: ${today}`;
    }
    await db.collection("offers").doc(off.id).update({ ...parsed.changes, updatedAt: new Date().toISOString() });
    await logActivity(db,"edit_offer","تعديل عرض: "+off.title,"تليجرام"); return `✅ تم تعديل: ${off.title}`;
  }
  if (t === "delete_offer") {
    const off = offs.find(o => o.id === parsed.offerId);
    if (!off) return `❌ ID غلط: ${parsed.offerId}`;
    await db.collection("offers").doc(parsed.offerId).delete();
    await logActivity(db,"delete_offer","حذف عرض: "+off.title,"تليجرام"); return `🗑️ تم حذف: ${off.title}`;
  }
  if (t === "edit_account") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) return `❌ ID غلط: ${parsed.accountId}`;
    await db.collection("accounts").doc(acc.id).update({ ...parsed.changes, updatedAt: new Date().toISOString() });
    await logActivity(db,"edit_account","تعديل أكونت: "+acc.name,"تليجرام"); return `✅ تم تعديل: ${acc.name}`;
  }
  if (t === "add_reply") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) return `❌ ID غلط: ${parsed.accountId}`;
    const replies = (acc.extraReplies || []).concat([{ label: parsed.label, text: parsed.text }]);
    await db.collection("accounts").doc(acc.id).update({ extraReplies: replies, updatedAt: new Date().toISOString() });
    await logActivity(db,"add_reply","إضافة رد لـ "+acc.name,"تليجرام"); return `✅ تم إضافة الرد لـ ${acc.name}`;
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
      joinedDate: new Date().toISOString().slice(0,10),
      updatedAt: new Date().toISOString(),
    });
    return `✅ تم إضافة الأكونت
الاسم: ${parsed.name}
الكاتيجوري: ${parsed.category || "عام"}

تقدر تضيف تفاصيل أكتر من السايت ✏️`;
  }
  if (t === "add_info") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) return `❌ ID غلط: ${parsed.accountId}`;
    const existing = acc.trainedQA || [];
    const isDup = existing.find(x => x.q && x.q.trim() === (parsed.question || "").trim());
    const newQA = isDup
      ? existing.map(x => x.q.trim() === parsed.question.trim() ? { q: x.q, a: parsed.answer } : x)
      : [...existing, { q: parsed.question, a: parsed.answer }];
    await db.collection("accounts").doc(acc.id).update({ trainedQA: newQA, updatedAt: new Date().toISOString() });
    return `✅ تم حفظ المعلومة في تدريب البوت\nالأكونت: ${acc.name}\nالسؤال: ${parsed.question}\nالإجابة: ${parsed.answer}`;
  }
  if (t === "delete_account") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) return `❌ ID غلط: ${parsed.accountId}`;
    await db.collection("accounts").doc(parsed.accountId).delete();
    // Delete account offers too
    const offSnap = await db.collection("offers").where("accountId","==",parsed.accountId).get();
    const batch = db.batch();
    offSnap.docs.forEach(d => batch.delete(d.ref));
    if(offSnap.docs.length) await batch.commit();
    return `🗑️ تم حذف الأكونت: ${acc.name}\nوكمان اتحذف ${offSnap.docs.length} عرض معاه`;
  }
  if (t === "delete_reply") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) return `❌ ID غلط: ${parsed.accountId}`;
    const replies = (acc.extraReplies || []).filter(r => r.label !== parsed.label);
    await db.collection("accounts").doc(acc.id).update({ extraReplies: replies, updatedAt: new Date().toISOString() });
    return `✅ تم حذف الرد "${parsed.label}" من ${acc.name}`;
  }
  if (t === "delete_info") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) return `❌ ID غلط: ${parsed.accountId}`;
    const qa = (acc.trainedQA || []).filter(q => q.q !== parsed.question);
    await db.collection("accounts").doc(acc.id).update({ trainedQA: qa, updatedAt: new Date().toISOString() });
    return `✅ تم حذف السؤال من تدريب البوت\nالأكونت: ${acc.name}`;
  }
  if (t === "delete_image") {
    const acc = accs.find(a => a.id === parsed.accountId);
    if (!acc) return `❌ ID غلط: ${parsed.accountId}`;
    const imgs = (acc.galleryImages || []).filter(img => img !== parsed.imageUrl);
    await db.collection("accounts").doc(acc.id).update({ galleryImages: imgs, updatedAt: new Date().toISOString() });
    return `✅ تم حذف الصورة من ألبوم ${acc.name}`;
  }
  if (t === "change_password") {
    if (!parsed.newPassword || parsed.newPassword.length < 4) return `❌ الباسورد لازم يكون 4 حروف على الأقل`;
    await db.collection("settings").doc("admin").set({ password: parsed.newPassword, updatedAt: new Date().toISOString() }, { merge: true });
    return `✅ تم تغيير باسورد الأدمن بنجاح!\nالباسورد الجديد: ${parsed.newPassword}`;
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

  // ══ KEYWORD DETECTION — بدون AI ══
  try {
    const db = getDB();
    const accsSnap = await db.collection("accounts").get();
    const offsSnap = await db.collection("offers").get();
    const accs = accsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const offs = offsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    function findAcc(name) {
      if (!name) return null;
      name = name.trim();
      return accs.find(a => a.name === name)
        || accs.find(a => a.name.includes(name) || name.includes(a.name));
    }

    // 1. تغيير الباسورد
    const pwMatch = text.match(/(?:غير|عدل|بدل|change)\s*(?:ال)?(?:باسورد|password|كلمة\s*المرور)\s*(?:خليه|الي|إلى|لـ|to|=|:)?\s*([\S]{2,30})/i);
    if (pwMatch) {
      const newPw = pwMatch[1].trim();
      await db.collection("settings").doc("admin").set({ password: newPw, updatedAt: new Date().toISOString() }, { merge: true });
      await sendTG(chatId, `🔐 تم تغيير الباسورد!\nالجديد: ${newPw}`);
      return res.status(200).send("ok");
    }

    // 2. إضافة رد جاهز — "ضيف رد في [أكونت] اسمه [اسم] المحتوي [نص]"
    const addReplyMatch = text.match(/(?:ضيف|اضف|أضف)\s*رد\s*(?:في|ل|لـ)\s*(.+?)\s*اسمه\s*(.+?)\s*(?:المحتوي|المحتوى|النص|وهو|هو)\s*(.+)/is);
    if (addReplyMatch) {
      const acc = findAcc(addReplyMatch[1]);
      const label = addReplyMatch[2].trim();
      const replyText = addReplyMatch[3].trim();
      if (!acc) { await sendTG(chatId, `❌ مش لاقي أكونت "${addReplyMatch[1]}"\n${accs.map(a=>`• ${a.name}`).join("\n")}`); return res.status(200).send("ok"); }
      const replies = (acc.extraReplies || []).concat([{ label, text: replyText }]);
      await db.collection("accounts").doc(acc.id).update({ extraReplies: replies, updatedAt: new Date().toISOString() });
      await sendTG(chatId, `✅ تم إضافة الرد!\nالأكونت: ${acc.name}\nالاسم: ${label}\nالنص: ${replyText}`);
      return res.status(200).send("ok");
    }

    // 3. حذف رد جاهز — "احذف رد [اسم] من [أكونت]"
    const delReplyMatch = text.match(/(?:احذف|امسح|ازل|حذف|مسح)\s*رد\s*(.+?)\s*(?:من|في)\s*(.+)/is);
    if (delReplyMatch) {
      const acc = findAcc(delReplyMatch[2]);
      const label = delReplyMatch[1].trim();
      if (!acc) { await sendTG(chatId, `❌ مش لاقي أكونت "${delReplyMatch[2]}"`); return res.status(200).send("ok"); }
      const replies = (acc.extraReplies || []).filter(r => r.label !== label);
      await db.collection("accounts").doc(acc.id).update({ extraReplies: replies, updatedAt: new Date().toISOString() });
      await sendTG(chatId, `✅ تم حذف الرد "${label}" من ${acc.name}`);
      return res.status(200).send("ok");
    }

    // 4. إضافة عرض — "ضيف عرض في [أكونت] اسمه [عنوان] ينتهي [تاريخ]"
    const addOfferMatch = text.match(/(?:ضيف|اضف|أضف)\s*عرض\s*(?:في|ل|لـ)\s*(.+?)\s*اسمه\s*(.+?)(?:\s*ينتهي\s*([\d\-\/]+))?$/is);
    if (addOfferMatch) {
      const acc = findAcc(addOfferMatch[1]);
      const title = addOfferMatch[2].trim();
      if (!acc) { await sendTG(chatId, `❌ مش لاقي أكونت "${addOfferMatch[1]}"\n${accs.map(a=>`• ${a.name}`).join("\n")}`); return res.status(200).send("ok"); }
      if (!addOfferMatch[3]) { await sendTG(chatId, `📅 تمام! العرض "${title}" لـ ${acc.name}\nبس محتاج تاريخ الانتهاء — ابعت: YYYY-MM-DD`); return res.status(200).send("ok"); }
      const expiry = addOfferMatch[3].replace(/\//g, "-");
      const id = "off_" + Date.now();
      await db.collection("offers").doc(id).set({ id, accountId: acc.id, title, description: "", content: "", image: "", link: "", expiryDate: expiry, badge: "جديد", updatedAt: new Date().toISOString() });
      await sendTG(chatId, `✅ تم إضافة العرض!\nالأكونت: ${acc.name}\nالعنوان: ${title}\nينتهي: ${expiry}`);
      return res.status(200).send("ok");
    }

    // 5. حذف عرض — "احذف عرض [اسم] من [أكونت]"
    const delOfferMatch = text.match(/(?:احذف|امسح|حذف|مسح)\s*عرض\s*(.+?)(?:\s*(?:من|في)\s*(.+))?$/is);
    if (delOfferMatch) {
      const title = delOfferMatch[1].trim();
      const off = offs.find(o => o.title.includes(title) || title.includes(o.title));
      if (!off) { await sendTG(chatId, `❌ مش لاقي عرض اسمه "${title}"`); return res.status(200).send("ok"); }
      await db.collection("offers").doc(off.id).delete();
      await sendTG(chatId, `🗑️ تم حذف العرض: ${off.title}`);
      return res.status(200).send("ok");
    }

    // 6. إضافة أكونت — "ضيف أكونت اسمه [اسم] كاتيجوري [نوع]"
    const addAccMatch = text.match(/(?:ضيف|اضف|أضف)\s*(?:اكونت|أكونت|account)\s*اسمه\s*(.+?)(?:\s*(?:كاتيجوري|كتيجوري|نوعه|نوع)\s*(.+))?$/is);
    if (addAccMatch) {
      const name = addAccMatch[1].trim();
      const category = (addAccMatch[2] || "عام").trim();
      const id = "acc_" + Date.now();
      await db.collection("accounts").doc(id).set({ id, name, category, description: "", status: "نشط", avatar: "", coverImage: "", tags: [], links: [], extraReplies: [], galleryImages: [], trainedQA: [], fixedReply: "", timesReply: "", contactReply: "", pinned: false, joinedDate: new Date().toISOString().slice(0,10), updatedAt: new Date().toISOString() });
      await sendTG(chatId, `✅ تم إضافة الأكونت!\nالاسم: ${name}\nالكاتيجوري: ${category}`);
      return res.status(200).send("ok");
    }

    // 7. حذف أكونت — "احذف أكونت [اسم]"
    const delAccMatch = text.match(/(?:احذف|امسح|حذف|مسح)\s*(?:اكونت|أكونت|account)\s*(.+)/is);
    if (delAccMatch) {
      const acc = findAcc(delAccMatch[1]);
      if (!acc) { await sendTG(chatId, `❌ مش لاقي أكونت "${delAccMatch[1]}"`); return res.status(200).send("ok"); }
      await db.collection("accounts").doc(acc.id).delete();
      await sendTG(chatId, `🗑️ تم حذف الأكونت: ${acc.name}`);
      return res.status(200).send("ok");
    }

    // 8. تعليم البوت — "علم البوت إن [أكونت] [سؤال] الإجابة [جواب]"
    const addInfoMatch = text.match(/(?:علم|علّم|درب)\s*(?:ال)?بوت\s*(?:إن|ان|انه|إنه)?\s*(.+?)\s*(?:الإجابة|الاجابة|والإجابة|والجواب|جوابه|ردوده)\s*(.+)/is);
    if (addInfoMatch) {
      const parts = addInfoMatch[1].trim().split(/\s+/);
      let acc = null, question = addInfoMatch[1].trim();
      // try to find acc name at start
      for (let i = parts.length; i > 0; i--) {
        const candidate = parts.slice(0, i).join(" ");
        const found = findAcc(candidate);
        if (found) { acc = found; question = parts.slice(i).join(" "); break; }
      }
      const answer = addInfoMatch[2].trim();
      if (!acc || !question) { await sendTG(chatId, `❌ مش فاهم الأكونت أو السؤال\nاكتب: علم البوت إن [اسم الأكونت] [السؤال] الإجابة [الجواب]`); return res.status(200).send("ok"); }
      const existing = acc.trainedQA || [];
      const isDup = existing.find(x => x.q.trim() === question.trim());
      const newQA = isDup ? existing.map(x => x.q.trim() === question.trim() ? { q: x.q, a: answer } : x) : [...existing, { q: question, a: answer }];
      await db.collection("accounts").doc(acc.id).update({ trainedQA: newQA, updatedAt: new Date().toISOString() });
      await sendTG(chatId, `✅ تم تدريب البوت!\nالأكونت: ${acc.name}\nالسؤال: ${question}\nالجواب: ${answer}`);
      return res.status(200).send("ok");
    }

    // 9. مسح/تعديل الرد الثابت — "امسح الرد الثابت من [أكونت]" أو "عدل الرد الثابت في [أكونت] خليه [نص]"
    const fixedReplyMatch = text.match(/(?:امسح|احذف|عدل|غير)\s*(?:ال)?رد\s*(?:ال)?ثابت\s*(?:من|في|ل)\s*(.+?)(?:\s*(?:خليه|وخليه|يكون)\s*(.+))?$/is);
    if (fixedReplyMatch) {
      const acc = findAcc(fixedReplyMatch[1]);
      const newFixed = fixedReplyMatch[2] ? fixedReplyMatch[2].trim() : "";
      if (!acc) { await sendTG(chatId, `❌ مش لاقي أكونت "${fixedReplyMatch[1]}"`); return res.status(200).send("ok"); }
      await db.collection("accounts").doc(acc.id).update({ fixedReply: newFixed, updatedAt: new Date().toISOString() });
      await sendTG(chatId, newFixed ? `✅ تم تعديل الرد الثابت لـ ${acc.name}` : `✅ تم مسح الرد الثابت من ${acc.name}`);
      return res.status(200).send("ok");
    }

    // 10. تعديل المواعيد — "عدل مواعيد [أكونت] خليها [نص]"
    const timesMatch = text.match(/(?:عدل|غير|بدل)\s*(?:ال)?مواعيد\s*(?:في|من|ل)?\s*(.+?)\s*(?:خليها|خليه|يكون|وخليها)\s*(.+)/is);
    if (timesMatch) {
      const acc = findAcc(timesMatch[1]);
      const newTimes = timesMatch[2].trim();
      if (!acc) { await sendTG(chatId, `❌ مش لاقي أكونت "${timesMatch[1]}"`); return res.status(200).send("ok"); }
      await db.collection("accounts").doc(acc.id).update({ timesReply: newTimes, updatedAt: new Date().toISOString() });
      await sendTG(chatId, `✅ تم تعديل المواعيد لـ ${acc.name}`);
      return res.status(200).send("ok");
    }

    // 11. تعديل التواصل — "عدل التواصل في [أكونت] خليه [نص]"
    const contactMatch = text.match(/(?:عدل|غير|بدل)\s*(?:ال)?(?:تواصل|كونتاكت|رقم)\s*(?:في|من|ل)?\s*(.+?)\s*(?:خليه|خليها|يكون)\s*(.+)/is);
    if (contactMatch) {
      const acc = findAcc(contactMatch[1]);
      const newContact = contactMatch[2].trim();
      if (!acc) { await sendTG(chatId, `❌ مش لاقي أكونت "${contactMatch[1]}"`); return res.status(200).send("ok"); }
      await db.collection("accounts").doc(acc.id).update({ contactReply: newContact, updatedAt: new Date().toISOString() });
      await sendTG(chatId, `✅ تم تعديل التواصل لـ ${acc.name}`);
      return res.status(200).send("ok");
    }

  } catch(kwErr) {
    console.error("keyword detection error:", kwErr.message);
  }

  try {
    const db = getDB();

    // ══ REPLY TO UNANSWERED QUESTION — handle first, before AI ══
    if (message.reply_to_message) {
      const originalText = message.reply_to_message.text || "";
      if (originalText.includes("[ID:uq_")) {
        const accsSnap = await db.collection("accounts").get();
        const accs = accsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        const result = await handleReply(db, text, originalText, accs);
        if (result) {
          await sendTG(chatId, `✅ تم حفظ الإجابة في تدريب البوت!\n\nالأكونت: ${result.accName}\nالسؤال: ${result.q}\nالإجابة: ${text}`);
          return res.status(200).send("ok");
        }
      }
    }

    // ══ NORMAL ADMIN COMMAND ══
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
