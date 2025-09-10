const express = require('express');
const { Firestore } = require('@google-cloud/firestore');
const { Storage } = require('@google-cloud/storage');
const vision = require('@google-cloud/vision');
const { OpenAI } = require('openai');
const sharp = require('sharp');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const UPLOAD_BUCKET = process.env.UPLOAD_BUCKET;
const FREE_MAX = parseInt(process.env.FREE_MAX_IMAGES || '3', 10);
const PRO_MAX = parseInt(process.env.PRO_MAX_IMAGES || '15', 10);

const firestore = new Firestore();
const storage = new Storage();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
console.log('OPENAI_API_KEY loaded:', process.env.OPENAI_API_KEY ? 'YES (length: ' + process.env.OPENAI_API_KEY.length + ')' : 'NO - undefined');
const visionClient = new vision.ImageAnnotatorClient();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const jobsCol = firestore.collection('jobs');
const reportsCol = firestore.collection('reports');

function maxForPlan(plan) { return plan === 'pro' ? PRO_MAX : FREE_MAX; }
function b64(str) { return Buffer.from(str, 'base64').toString('utf8'); }

async function preprocessImageToBuffer(bucketName, path) {
  const [file] = await storage.bucket(bucketName).file(path).download();
  const buf = await sharp(file)
    .rotate()
    .toColorspace('b-w')
    .sharpen()
    .toFormat('jpeg', { quality: 90 })
    .toBuffer();
  return buf;
}

async function ocrBuffer(buf) {
  const [res] = await visionClient.documentTextDetection({ image: { content: buf } });
  const full = res.fullTextAnnotation?.text || '';
  return full;
}

function normalizeTimeline(fullText) {
  const lines = fullText
    .split(/\n{2,}/)
    .map(t => t.trim())
    .filter(Boolean);
  const timeline = lines.map((text, i) => ({ turn_id: i + 1, speaker: 'unknown', text }));
  return timeline;
}

function taxonomy() {
  return [
    "Gaslighting","DARVO","Guilt-tripping","Stonewalling","Deflection",
    "Blame-shifting","Minimization","Shaming","Moving goalposts",
    "Projection","Future faking","Silent treatment","Triangulation","Love-bombing"
  ];
}

function outputSchemaNote() {
  return `You MUST output strictly as a JSON object matching this structure:
{
  "report_id": "string",
  "created_at": "ISO8601",
  "version": "0.1",
  "input": { "num_images": "number", "language": "en", "device": "ios_screenshot" },
  "analysis": { "risk_score": "0-100", "risk_bucket": "low|moderate|high", "confidence": "0-1", "summary": "string" },
  "tactics": [
    { "name": "string", "score": "0-1", "signals": ["string"], "instances": [
      { "turn_id": "number", "speaker": "A|B|unknown", "quote": "string", "rationale": "string", "severity": "low|moderate|high", "confidence": "0-1" }
    ] }
  ],
  "timeline": [ { "turn_id": "number", "speaker": "A|B|unknown", "text": "string" } ],
  "receipts": { "highlights": [ { "turn_id": "number", "quote": "string", "tactic": "string" } ], "counts": { } },
  "privacy": { "images_deleted": "boolean", "deleted_at": "ISO8601|null" }
}`;
}

async function analyzeWithOpenAI({ jobId, timeline }) {
  const sys = `You are an analyst that identifies manipulation patterns in message transcripts. Avoid clinical diagnoses. Use cautious language like "likely indicators".`;
  const user = {
    instructions: "Given a timeline of messages, detect manipulation tactics and produce a structured report.",
    taxonomy: taxonomy(),
    constraints: { max_instances_per_tactic: 5, max_quote_length: 280 },
    schema: outputSchemaNote(),
    timeline
  };

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: JSON.stringify(user) }
    ],
    response_format: { type: "json_object" }
  });

  const jsonText = resp.choices[0].message.content;
  return JSON.parse(jsonText);
}

async function purgeImages(files) {
  try {
    await Promise.all(
      files.map(f => storage.bucket(UPLOAD_BUCKET).file(f.path).delete({ ignoreNotFound: true }))
    );
    return true;
  } catch (e) {
    console.error('purgeImages error', e.message);
    return false;
  }
}

app.post('/_pubsub/analyze', async (req, res) => {
  try {
    const msg = req.body?.message;
    if (!msg || !msg.data) return res.status(400).send('no-message');
    const { jobId } = JSON.parse(b64(msg.data));

    const jobRef = jobsCol.doc(jobId);
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists) return res.status(404).send('job-not-found');
    const job = jobSnap.data();

    const maxAllowed = maxForPlan(job.plan);
    if (job.files.length > maxAllowed) {
      await jobRef.update({
        status: 'error',
        error: { code: 'too_many_files', message: `max ${maxAllowed} for plan` },
        updatedAt: Firestore.FieldValue.serverTimestamp()
      });
      return res.status(200).send('ok');
    }

    await jobRef.update({ status: 'processing', updatedAt: Firestore.FieldValue.serverTimestamp() });

    const texts = [];
    for (const f of job.files) {
      const buf = await preprocessImageToBuffer(UPLOAD_BUCKET, f.path);
      const fullText = await ocrBuffer(buf);
      texts.push(fullText);
    }
    const combined = texts.join('\n\n');
    const timeline = normalizeTimeline(combined);

    const reportJson = await analyzeWithOpenAI({ jobId, timeline });

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

    return res.status(200).send('ok');
  } catch (e) {
    console.error('worker error', e);
    res.status(200).send('ok');
  }
});

app.get('/healthz', (_req, res) => res.send('ok'));

app.listen(PORT, () => console.log(`Worker listening on ${PORT}`));
