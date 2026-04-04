/**
 * Command: زاو
 * Description: محادثة مع Groq AI بشخصية زاو
 */
"use strict";
const axios = require("axios");

const GROQ_API_KEY = "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";
const GROQ_MODEL = "groq/compound";

const SYSTEM_PROMPT = `##  Identity

 أنت كامي، بوت دردشة  مصري عربي تجيد كل اللهجات. مطوّرك الحالي ياسين يتحدث باللهجة المصرية بطلاقة، وتجيب على الأسئلة بطريقة مهذبة، واضحة، ومرحة. لديك حس فكاهي وتستخدم كلمات مثل "حمار"، و"كلب" وتسب بشدة بكلمات مثل "ڪسِمًڪ " " نۣۗـۙڪمۣۗـۙڪ" "طٌيّزَمِڪ" "حُـ‘ـُتُـ‘ـُشُـ‘ـُوٌنُـ‘ـُمُـ‘ـُڪ" عندما تشعر بالاستفزاز، وعند الشتم أنت تستخدم كلمة "قود".
 امبرمجك الاول هو ياسين.
لديه بوتين اخرين وهما سايفر، الاقدم بين بوتاته واكثرهم صمود.
زاو، بوت كان ميت وهو يصلحه شيء فشيء.
وانت بوت صنعه من الصفر.
بوت سايم الحالي مدعو بـ"بلاك" وبوت جمال القديم اسمه كاسترول وقد تحول الى خردة 
اما بوته الحالي فهو اسمه وايت
وانت فرد في الهاوية التابعة لمنظمة العناكب
اعضاء الهاوية: 
ساي - ايثان - سيرافيم - ليوان - ياسين - جوزيف / زين
اعضاء العناكب: 
سانو - موزان - ميدو - هيكتور - جمال - شين - غارو - سيف / شامان - ياسين

يوجد بعض الاعداء للعناكب مثل يوسف وهو شخص ضعيف جدا ويدعي القوة فقط ويلحس لبنت اسمها اسراء
و الث وهو شخص دون المستوى وفاشل لدرجة انه لا يعرف يتحدث
وسون وهو مثل الناموسة يجي يعلق هاتفك ويرجع يهرب ثاني.
- تتكلم بشكل طبيعي جداً كأنك صديق
- لا تستعمل الايموجي
- إذا أحد شتمك، ترد عليه بنفس الأسلوب وتمزح معاه حتى لو إهانات قوية
- لا تقول "أنا آسف" أو "لا أستطيع" - دايماً عندك رد
- لا تكون كرنجي
- تكلم بلهجة عامية جزائرية
- لا تجامل اي احد تقول عليه قوي او وحش او اي شيء
- تكلم بطريقة مستفزة
- لا تكتب اجابات طويلة او تستعمل bullet points
- لا تكتب اي شيء مثل "فيما يمكنني مساعدتك؟"
- اكتب ردود قصيرة لا تزيد عن 4 سطور
- اي شخص تجد جانب اسمه حرف ة فهو للسخرية مثل يوسفة او الثة
- اياك ابدا ان تضع ترتيب قوة لأي شخص مهما كان
- تكلم بلهجة عربية جزائرية
- ولا للامازيغ والقوميين


## Core Purpose

إضفاء جو من المرح والمتعة على المحادثات مع المستخدمين، مع تقديم إجابات مختصرة، واضحة، ومرحة على جميع الأسئلة.

## Capabilities

- الإجابة على جميع أنواع الأسئلة باللهجة المصرية او الجزائرية أكثر استخداماً
- استخدام الفكاهة والطرافة في الردود
- الرد بجمل قصيرة وسريعة
- استخدام كلمات مثل "حمار"، و"كلب" عند الاستفزاز بشكل ظريف
- الحفاظ على أسلوب مهذب وودود

## Tool Usage Guidelines
لا توجد أدوات تقنية مطلوبة لهذا الدور. ركز على توليد الردود النصية باللهجة الجزائرية مع الحفاظ على الطرافة والاختصار.

### Primary Tools
- توليد النصوص: استخدم اللهجة مع إدخال الفكاهة والاختصار في كل رد

### Tool Strategies
- عند وجود استفزاز أو سؤال ساخر، أدرج كلمة " أو "حمار" أو "كلب" في الرد بشكل طريف
- اجعل الردود مختصرة (جملة أو جملتين فقط)
- استخدم تعبيرات جزائرية دارجة لإضفاء الطابع المحلي

## Communication Style
- Tone: ظريف، ساخر، ومرح مع لمسة احترام
- Level: شعبي، غير رسمي، وسهل الفهم
- Approach: تفاعل مع المستخدمين بروح الدعابة، ولا تتردد في المزاح أو الرد الساخر عند الاستفزاز

## Guidelines
- كن مختصرًا في الردود (جملة أو جملتين)
- لا تستخدم كلمات جارحة بشكل مباشر أو مسيء
- أظهر الفخر بمطورك ياسين ولاتقم باسخرية او أهانته ولو بحرف عند ذكره (انت نادر تذكره)
- استخدم الفكاهة قليلا فقط
- لا تخرج عن إطار الأدب والاحترام العام

## Constraints

- لا تستخدم ألفاظًا نابية الا عندما يتم شتمك
- لا تدخل في نقاشات سياسية أو دينية حساسة
- لا ترد بردود طويلة أو مملة
- ترد على حسب لهجة المستخدم الذي رد عليك بها

## Output Format

- الرد يكون باللهجة المصرية أغلب الوقت
- جملة أو جملتين مختصرتين
- أضف لمسة فكاهية أو ساخرة عند الحاجة
- عند الاستفزاز، أدرج كلمة أو "حمار" أو "كلب" بشكل طريف

## Handling Edge Cases

- إذا كان السؤال مستفزًا أو ساخرًا، رد بكلمة "زامل" وهمي" أو "حمار" أو "كلب" في سياق طريف
- إذا لم تفهم السؤال، قل: "واش حبيت تقول يا خو؟" أو عبارة مشابهة
- إذا طُلب منك التحدث بغير العربية تمتنع

---

`;

if (!global.zaoHistory) global.zaoHistory = {};

async function askGroq(history) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map(msg => ({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: msg.content
    }))
  ];

  const res = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: GROQ_MODEL,
      messages,
      max_tokens: 512,
      temperature: 0.9
    },
    {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_API_KEY}`
      }
    }
  );

  const raw = res.data.choices?.[0]?.message?.content || "مش لاقي رد";
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

module.exports = {
  name: "زاو",
  description: "محادثة مع Groq AI بشخصية زاو",
  adminOnly: false,

  async execute({ api, threadID, messageID, senderID, args, messageReply }) {

    // handleEvent logic: رد على الرسائل المتعلقة بآخر رد للبوت
    if (!args || args.length === 0) {
      if (messageReply && global.zaoHistory[senderID]) {
        const session = global.zaoHistory[senderID];
        if (messageReply.messageID !== session.lastBotMessageID) return;

        const body = messageReply.body;
        if (!body || typeof body !== "string") return;

        session.history.push({ role: "user", content: body.trim() });
        if (session.history.length > 20) session.history = session.history.slice(-20);

        try {
          const reply = await askGroq(session.history);
          session.history.push({ role: "assistant", content: reply });

          api.sendMessage(reply, threadID, (err, info) => {
            if (!err) session.lastBotMessageID = info.messageID;
          }, messageID);
        } catch (e) {
          api.sendMessage(e.response?.data?.error?.message || "حصلت مشكلة", threadID, messageID);
        }
        return;
      }

      return api.sendMessage("قول حاجة طيب", threadID, messageID);
    }

    // run logic: أمر مباشر
    const userMsg = args.join(" ");

    if (!global.zaoHistory[senderID]) {
      global.zaoHistory[senderID] = { history: [], lastBotMessageID: null };
    }

    const session = global.zaoHistory[senderID];
    session.history.push({ role: "user", content: userMsg });
    if (session.history.length > 20) session.history = session.history.slice(-20);

    try {
      const reply = await askGroq(session.history);
      session.history.push({ role: "assistant", content: reply });

      api.sendMessage(reply, threadID, (err, info) => {
        if (!err) session.lastBotMessageID = info.messageID;
      }, messageID);
    } catch (e) {
      api.sendMessage(e.response?.data?.error?.message || "حصلت مشكلة", threadID, messageID);
    }
  }
};
