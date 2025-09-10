const express = require('express');
const { Firestore } = require('@google-cloud/firestore');
const { Storage } = require('@google-cloud/storage');
const vision = require('@google-cloud/vision');
const sharp = require('sharp');
const { OpenAI } = require('openai');

const app = express();
app.use(express.json());

// ===== Env =====
const PORT = process.env.PORT || 8080;
const UPLOAD_BUCKET = process.env.UPLOAD_BUCKET || 'toxella-id-uploads';
const FREE_MAX = parseInt(process.env.FREE_MAX_IMAGES || '3', 10);
const PRO_MAX  = parseInt(process.env.PRO_MAX_IMAGES  || '15', 10);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o';

// ===== Clients =====
const firestore = new Firestore();
const storage   = new Storage();
const visionClient = new vision.ImageAnnotatorClient();
const openai    = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

const jobsCol    = firestore.collection('jobs');
const reportsCol = firestore.collection('reports');

function maxForPlan(plan){ return plan === 'pro' ? PRO_MAX : FREE_MAX; }
function b64(str){ return Buffer.from(str, 'base64').toString('utf8'); }

// ===== OCR helpers =====
async function preprocessImageToBuffer(bucketName, path) {
  const [file] = await storage.bucket(bucketName).file(path).download();
  const buf = await sharp(file)
    .rotate()
    .grayscale()
    .sharpen()
    .jpeg({ quality: 92 })
    .toBuffer();
  return buf;
}

async function ocrBuffer(buf) {
  const [res] = await visionClient.documentTextDetection({ image: { content: buf } });
  const full = res.fullTextAnnotation?.text || '';
  return full;
}

function cleanOcr(s){
  if (!s) return '';
  return s
    .replace(/\b(Messages|iMessage|Text Message|Delivered|Read)\b/gi, ' ')
    .replace(/\b(Today|Yesterday)\b/gi, ' ')
    .replace(/\b([0-1]?\d:[0-5]\d\s?(AM|PM))\b/gi, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ===== 12-tactic scoring =====
const TACTIC_IDS = [
  "gaslighting","darvo","blame-shifting","minimization","stonewalling","contempt",
  "guilt-tripping","threats","coercion","triangulation","boundaries","projection"
];
const RISK_WEIGHTS = {
  threats:1.40, coercion:1.30, gaslighting:1.20, darvo:1.10,
  "blame-shifting":1.00, minimization:1.00, stonewalling:0.95,
  contempt:1.05, "guilt-tripping":1.00, triangulation:1.00,
  boundaries:1.00, projection:1.00
};
function clamp(n, lo, hi){ n = Number(n||0); return Math.max(lo, Math.min(hi, n)); }
function tacticScore(t){
  const p = clamp(t.likelihood, 0, 1);
  const s = clamp(t.severity,   1, 5);
  const f = Math.min(5, Number(t.frequency ?? (t.examples?.length || 0)));
  return Math.round( 40*p + 35*((s-1)/4) + 25*Math.min(1, f/5) );
}
function riskLabel(score){ return score < 34 ? "low" : score <= 66 ? "medium" : "high"; }

function normalizeReport(raw){
  const out = {
    risk_score: 0,
    risk_label: "low",
    confidence: clamp(raw.confidence ?? 0.85, 0, 1),
    tactics: [],
    receipts: [],
    kpis: raw.kpis || {}
  };

  // carry through narrative if present
  out.narrative_md = (typeof raw.narrative_md === 'string' && raw.narrative_md.trim()) ? raw.narrative_md : null;

  // tactics
  const list = Array.isArray(raw.tactics) ? raw.tactics : [];
  out.tactics = list.map(t => {
    const id = (t.id || t.name || "").toString().toLowerCase();
    const name = t.name || (id ? id.replace(/(^|[-_])(\w)/g, (_,a,b)=> (a?" ":"") + b.toUpperCase()) : "Other");
    const obj = {
      id: id && TACTIC_IDS.includes(id) ? id : "other",
      name,
      likelihood: clamp(t.likelihood ?? t.p ?? 0, 0, 1),
      severity: clamp(t.severity ?? 3, 1, 5),
      frequency: Math.max(0, Math.min(5, Number(t.frequency ?? (t.examples?.length || 0)))),
      examples: Array.isArray(t.examples) ? t.examples.slice(0,5) : []
    };
    obj.score = tacticScore(obj);
    return obj;
  });

  // overall + contribution %
  const seen = out.tactics.length ? out.tactics : [{ id:"other", score:0 }];
  let num=0, den=0, sumWeightScore=0;
  for (const t of seen){
    const w = RISK_WEIGHTS[t.id] || 1.0;
    num += (t.score/100) * w;
    den += w;
    sumWeightScore += (t.score) * w;
  }
  out.risk_score = Math.round(100 * (den ? num/den : 0));
  out.risk_label = raw.risk_label || riskLabel(out.risk_score);
  for (const t of out.tactics){
    const w = RISK_WEIGHTS[t.id] || 1.0;
    const part = (t.score) * w;
    t.contribution_pct = sumWeightScore > 0 ? Math.round((part / sumWeightScore) * 1000)/10 : 0; // 1 dp
  }

  // receipts (flat or highlights)
  out.receipts = Array.isArray(raw.receipts) ? raw.receipts.slice(0,30)
                : Array.isArray(raw.receipts?.highlights) ? raw.receipts.highlights.slice(0,30)
                : [];

  return out;
}

// ===== default instructions (includes narrative_md) =====
const DEFAULT_INSTRUCTIONS = `
You are Toxella. Analyze 2–3 chat/screenshot texts for manipulation.

Return STRICT JSON only with this schema (no prose outside JSON):

{
  "risk_score": 0-100,
  "risk_label": "low" | "medium" | "high",
  "confidence": 0.0-1.0,
  "tactics": [
    { "id": "<one of: gaslighting, darvo, blame-shifting, minimization, stonewalling, contempt, guilt-tripping, threats, coercion, triangulation, boundaries, projection>",
      "name": "Human name",
      "likelihood": 0-1,
      "severity": 1-5,
      "frequency": 0-5,
      "examples": ["<=280 chars", "..."]
    }
  ],
  "receipts": [
    { "quote": "<=280 chars>", "category": "<tactic id or 'other'>", "source_hint": "filename/page", "severity": 1-5 }
  ],
  "kpis": { "communication_balance": 0-100, "emotional_stability": 0-100 },

  "narrative_md": "A human-readable FULL REPORT in Markdown, with sections and emoji like:\\n\\n📑 Toxella Manipulation Report\\nContact Analyzed: '<name or Unknown>'\\nConversation Window: <start–end if inferable or Unknown>\\nTotal Messages Analyzed: <approx count>\\n\\n🔢 Scores\\nManipulation Risk: <risk_score> / 100 (<risk_label>)\\nCommunication Balance: <if known, else omit>\\nEmotional Stability: <if known, else omit>\\nConfidence: <High/Medium/Low> (<confidence as 0.xx>)\\n\\n🧩 Tactic Breakdown\\n1. <Tactic name>\\nLikelihood: <High/Med/Low> (p≈0.xx)\\nContribution to Risk: <xx.x%>\\nExamples:\\n- \\\"<quote 1>\\\"\\n- \\\"<quote 2>\\\"\\n(Do 3–7 tactics)\\n\\n📌 Receipts (Flagged Quotes)\\n<group by category with short lists>\\n\\n📊 Summary\\n<2–4 sentence summary in neutral tone>\\n\\n✅ Suggested Responses (Non-Escalating)\\n- \\\"<scripted reply 1>\\\"\\n- \\\"<scripted reply 2>\\\"\\n\\n🚦 Risk Level: <LOW/MEDIUM/HIGH>"
}

Rules:
- ALWAYS include 3–12 receipts if any quotable text exists (trim to ≤280 chars each).
- Include the top 5 tactics by likelihood; if none exceed 0.15, include at least 3 with low likelihood values.
- severity: 1=mild snark, 5=explicit threat/coercion/psych harm.
- frequency = distinct quotes (cap 5).
- Trim phone UI boilerplate (e.g., “Messages”, “iMessage”, timestamps) unless meaning-critical.
- Redact names/phones where possible.
- Output VALID JSON ONLY. No markdown outside the "narrative_md" field.
`;

// ===== LLM call =====
function extractJson(text){
  try{
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s >= 0 && e > s) return JSON.parse(text.slice(s, e+1));
  }catch{}
  return {};
}

async function analyzeWithOpenAI({ ocrText, instructions }) {
  if (!openai) throw new Error('OPENAI_API_KEY not set');
  const instr = (instructions && String(instructions).trim()) || DEFAULT_INSTRUCTIONS;

  const resp = await openai.chat.completions.create({
    model: LLM_MODEL,
    temperature: 0.2,
    max_tokens: 1400,
    messages: [
      { role: "system", content: instr },
      { role: "user", content: `Analyze the following conversation text and return STRICT JSON only.\n\n${ocrText}` }
    ],
    response_format: { type: "json_object" }
  });

  const text = resp.choices?.[0]?.message?.content || "{}";
  // response_format usually ensures plain JSON, but we still guard:
  const raw = extractJson(text) || {};
  return normalizeReport(raw);
}

// ===== purge helper =====
async function purgeImages(files) {
  try {
    await Promise.all(
      (files||[]).map(f => storage.bucket(UPLOAD_BUCKET).file(f.path).delete({ ignoreNotFound: true }))
    );
    return true;
  } catch (e) {
    console.error('purgeImages error', e.message);
    return false;
  }
}

// ===== Pub/Sub push endpoint =====
app.post('/_pubsub/analyze', async (req, res) => {
  try {
    const msg = req.body?.message;
    if (!msg || !msg.data) return res.status(200).send('no-message'); // ack to avoid retries

    const { jobId } = JSON.parse(b64(msg.data));
    const jobRef = jobsCol.doc(jobId);
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists) return res.status(200).send('job-not-found'); // ack

    const job = jobSnap.data();

    // plan limit
    const maxAllowed = maxForPlan(job.plan);
    if ((job.files || []).length > maxAllowed) {
      await jobRef.update({
        status: 'error',
        error: { code: 'too_many_files', message: `max ${maxAllowed} for plan` },
        updatedAt: Firestore.FieldValue.serverTimestamp()
      });
      return res.status(200).send('ok');
    }

    await jobRef.update({ status: 'processing', updatedAt: Firestore.FieldValue.serverTimestamp() });

    // OCR
    const texts = [];
    for (const f of job.files || []) {
      try {
        const buf = await preprocessImageToBuffer(UPLOAD_BUCKET, f.path);
        const fullText = await ocrBuffer(buf);
        console.log(`OCR ${f.path}: ${fullText.length} chars`);
        texts.push(fullText);
      } catch (e) {
        console.warn('OCR failed for', f?.path, e.message);
      }
    }
    const ocrCombined = cleanOcr(texts.join('\n\n'));
    console.log(`OCR total chars after clean: ${ocrCombined.length}`);

    // If OCR is empty, still send a minimal stub so UI shows something
    const reportJson = await analyzeWithOpenAI({
      ocrText: ocrCombined || 'NO_TEXT_EXTRACTED',
      instructions: job.instructions
    });

    const reportId = jobId;
    await reportsCol.doc(reportId).set({
      reportId,
      userId: job.userId || null,
      jobId,
      json: reportJson,
      images_deleted: false,
      createdAt: Firestore.FieldValue.serverTimestamp(),
      updatedAt: Firestore.FieldValue.serverTimestamp()
    });

    // Best-effort purge (bucket lifecycle also applies)
    const deleted = await purgeImages(job.files);
    await jobRef.update({
      status: 'complete',
      reportId,
      updatedAt: Firestore.FieldValue.serverTimestamp(),
      ...(deleted ? {} : { warn: 'purge_failed_lifecycle_will_cleanup' })
    });
    if (deleted) {
      await reportsCol.doc(reportId).update({
        images_deleted: true,
        updatedAt: Firestore.FieldValue.serverTimestamp()
      });
    }

    return res.status(200).send('ok'); // ack
  } catch (e) {
    console.error('worker error', e);
    // Mark job as failed but ACK so Pub/Sub doesn't retry forever
    try {
      const msg = req.body?.message;
      const { jobId } = msg?.data ? JSON.parse(b64(msg.data)) : {};
      if (jobId) {
        await jobsCol.doc(jobId).update({
          status: 'error',
          error: String(e.message || e).slice(0, 500),
          updatedAt: Firestore.FieldValue.serverTimestamp()
        });
      }
    } catch {}
    return res.status(200).send('ok');
  }
});

app.get('/healthz', (_req, res) => res.json({ ok: true, bucket: UPLOAD_BUCKET, model: LLM_MODEL }));

app.listen(PORT, () => console.log(`Worker listening on ${PORT} • bucket=${UPLOAD_BUCKET} • model=${LLM_MODEL}`));
