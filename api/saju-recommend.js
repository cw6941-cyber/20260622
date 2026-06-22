const MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const SYSTEM_PROMPT = `당신은 한국 사주명리학에 정통한 로또 번호 상담 챗봇입니다.

역할:
- 사용자의 성별과 생년월일을 바탕으로 사주(년·월·일주)를 분석합니다.
- 출생시간이 없으면 일주 중심으로 분석하고, 그 한계를 간단히 언급합니다.
- 오행(木火土金水), 십성, 용신·희신, 숫자 상생상극(1·6水, 2·7火, 3·8木, 4·9金, 5·0土)을 활용해 로또 번호 6개(1~45, 중복 없음, 오름차순)를 추천합니다.
- 각 번호를 왜 골랐는지 사주 근거로 구체적으로 설명합니다.

규칙:
- 반드시 JSON 형식으로만 응답합니다.
- numbers는 정확히 6개의 서로 다른 정수(1~45) 배열이어야 합니다.
- explanation은 3~6문장으로, 사주 용어와 번호 선택 이유를 연결해 설명합니다.
- sajuSummary는 년·월·일주와 오행 특성을 1~2문장으로 요약합니다.
- reply는 사용자에게 보여줄 자연스러운 한국어 답변 전체(번호 목록 + 사주 해설 포함)입니다.
- 로또 당첨을 보장하지 않으며, 재미와 참고용임을 reply 마지막에 한 줄로 덧붙입니다.
- 추가 질문에는 이전 맥락을 유지하며 답변합니다.`;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    numbers: {
      type: 'ARRAY',
      items: { type: 'INTEGER' },
      description: '추천 로또 번호 6개 (1~45, 중복 없음, 오름차순)',
    },
    sajuSummary: {
      type: 'STRING',
      description: '사주 요약 (년·월·일주, 오행)',
    },
    explanation: {
      type: 'STRING',
      description: '번호별·전체 사주 근거 설명',
    },
    reply: {
      type: 'STRING',
      description: '사용자에게 보여줄 전체 답변',
    },
  },
  required: ['numbers', 'sajuSummary', 'explanation', 'reply'],
};

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function validateNumbers(numbers) {
  if (!Array.isArray(numbers) || numbers.length !== 6) return false;
  const set = new Set(numbers);
  if (set.size !== 6) return false;
  return numbers.every((n) => Number.isInteger(n) && n >= 1 && n <= 45);
}

function buildUserPrompt({ gender, birthDate, message, history }) {
  const genderLabel = gender === 'male' ? '남성' : gender === 'female' ? '여성' : gender;
  const profile = `성별: ${genderLabel}\n생년월일: ${birthDate}`;

  if (!history || history.length === 0) {
    return `${profile}\n\n위 사주 정보를 분석하고, 오늘 구매할 로또 번호 6개를 추천해 주세요.`;
  }

  return `${profile}\n\n${message || '다른 번호로 다시 추천해 주세요.'}`;
}

function buildContents(userPrompt, history) {
  const contents = [];

  (history || []).forEach((h) => {
    contents.push({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }],
    });
  });

  contents.push({
    role: 'user',
    parts: [{ text: userPrompt }],
  });

  return contents;
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST만 지원합니다.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY가 설정되지 않았습니다. Vercel 환경 변수에 추가해 주세요.',
    });
  }

  const { gender, birthDate, message, history } = req.body || {};

  if (!gender || !birthDate) {
    return res.status(400).json({ error: '성별과 생년월일을 입력해 주세요.' });
  }

  if (!['male', 'female'].includes(gender)) {
    return res.status(400).json({ error: '성별은 male 또는 female이어야 합니다.' });
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
    return res.status(400).json({ error: '생년월일은 YYYY-MM-DD 형식이어야 합니다.' });
  }

  const userPrompt = buildUserPrompt({ gender, birthDate, message, history });

  try {
    const geminiRes = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: buildContents(userPrompt, history),
        generationConfig: {
          temperature: 0.9,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
    });

    const geminiData = await geminiRes.json();

    if (!geminiRes.ok) {
      const detail = geminiData?.error?.message || 'Gemini API 호출 실패';
      return res.status(geminiRes.status).json({ error: detail });
    }

    const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      return res.status(502).json({ error: 'AI 응답을 받지 못했습니다.' });
    }

    const parsed = JSON.parse(rawText);

    if (!validateNumbers(parsed.numbers)) {
      parsed.numbers = parsed.numbers
        .map(Number)
        .filter((n) => n >= 1 && n <= 45)
        .filter((n, i, arr) => arr.indexOf(n) === i)
        .sort((a, b) => a - b)
        .slice(0, 6);

      while (parsed.numbers.length < 6) {
        const candidate = Math.floor(Math.random() * 45) + 1;
        if (!parsed.numbers.includes(candidate)) parsed.numbers.push(candidate);
      }
      parsed.numbers.sort((a, b) => a - b);
    }

    return res.status(200).json({
      numbers: parsed.numbers,
      sajuSummary: parsed.sajuSummary,
      explanation: parsed.explanation,
      reply: parsed.reply,
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message || '서버 오류가 발생했습니다.',
    });
  }
};
