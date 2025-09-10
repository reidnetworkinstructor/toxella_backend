// index.js — Toxella API (Cloud Run)
// -----------------------------------
// Express API that issues GCS v4 signed URLs, creates jobs, and exposes job/report reads.

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Storage } = require('@google-cloud/storage');
const { PubSub } = require('@google-cloud/pubsub');
const { Firestore } = require('@google-cloud/firestore');
const { v4: uuidv4 } = require('uuid');

// -------------------------
// App & middleware
// -------------------------
const app = express();

// CORS: soft-launch mode (reflects the Origin). Lock to your Netlify origin later.
app.use(cors({ origin: true, maxAge: 3600 }));
app.use((req, res, next) => {
  // Helpful headers for browser uploads/fetch
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  next();
});

app.use(bodyParser.json({ limit: '2mb' }));

// -------------------------
// Env
// -------------------------
const PORT = process.env.PORT || 8080;
const PROJECT_ID = process.env.PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || '';
const REGION = process.env.REGION || 'us-central1';
const UPLOAD_BUCKET = process.env.UPLOAD_BUCKET; // REQUIRED
const PUBSUB_TOPIC = process.env.PUBSUB_TOPIC || 'analyze-jobs';
const FREE_MAX = parseInt(process.env.FREE_MAX_IMAGES || '3', 10);
const PRO_MAX = parseInt(process.env.PRO_MAX_IMAGES || '15', 10);

// -------------------------
// Clients
// -------------------------
const storage = new Storage();
const firestore = new Firestore();
const pubsub = new PubSub();

const jobsCol = firestore.collection('jobs');
const reportsCol = firestore.collection('reports');

// -------------------------
// Helpers
// -------------------------
function maxForPlan(plan) {
  return plan === 'pro' ? PRO_MAX : FREE_MAX;
}

async function buildSignedUploadUrls(jobId, count) {
  if (!UPLOAD_BUCKET) throw new Error('Missing UPLOAD_BUCKET environment variable');
  const expires = Date.now() + 15 * 60 * 1000; // 15 mins
  const urls = [];
  for (let i = 0; i < count; i++) {
    const path = `uploads/${jobId}/${i}.jpg`;
    const [url] = await storage
      .bucket(UPLOAD_BUCKET)
      .file(path)
      .getSignedUrl({
        version: 'v4',
        action: 'write',
        expires,
        // Important: the browser PUT must match this Content-Type exactly
        contentType: 'application/octet-stream'
      });
    urls.push({ path, uploadUrl: url, contentType: 'application/octet-stream' });
  }
  return urls;
}

// -------------------------
// Routes
// -------------------------
app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    project: PROJECT_ID,
    region: REGION,
    bucket: UPLOAD_BUCKET || null,
    topic: PUBSUB_TOPIC,
    limits: { free: FREE_MAX, pro: PRO_MAX }
  });
});

app.get('/', (_req, res) => {
  res.type('text/plain').send('Toxella API is running. See /healthz.');
});

// POST /signed-urls  { plan:"free"|"pro", count:Number? } -> { jobId, urls:[{path,uploadUrl,contentType}], limit }
app.post('/signed-urls', async (req, res) => {
  try {
    const { plan = 'free', count = 1 } = req.body || {};
    const limit = maxForPlan(plan);
    if (!Number.isFinite(count) || count < 1 || count > limit) {
      return res.status(400).json({ error: `count must be 1..${limit} for plan=${plan}` });
    }
    const jobId = uuidv4();
    const urls = await buildSignedUploadUrls(jobId, count);
    return res.json({ jobId, urls, limit });
  } catch (e) {
    console.error('signed-urls error:', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// POST /jobs  { jobId, plan, files:[{path,size?,mime?}], userId?, instructions? } -> {jobId,status:"queued"}
app.post('/jobs', async (req, res) => {
  try {
    const { jobId, plan = 'free', files = [], userId = null, instructions = null } = req.body || {};
    if (!jobId || !Array.isArray(files) || files.length < 1) {
      return res.status(400).json({ error: 'jobId and non-empty files[] required' });
    }
    const limit = maxForPlan(plan);
    if (files.length > limit) {
      return res.status(400).json({ error: `too many files for plan=${plan} (max ${limit})` });
    }

    const docRef = jobsCol.doc(jobId);
    await docRef.set({
      jobId,
      plan,
      userId,
      files,
      instructions, // <- optional per-job guidance the worker can use
      status: 'uploaded',
      createdAt: Firestore.FieldValue.serverTimestamp(),
      updatedAt: Firestore.FieldValue.serverTimestamp()
    });

    // Publish to worker
    const dataBuffer = Buffer.from(JSON.stringify({ jobId }));
    await pubsub.topic(PUBSUB_TOPIC).publishMessage({ data: dataBuffer });

    return res.json({ jobId, status: 'queued' });
  } catch (e) {
    console.error('create job error:', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// GET /jobs/:jobId -> {jobId,status,reportId?,error?}
app.get('/jobs/:jobId', async (req, res) => {
  try {
    const snap = await jobsCol.doc(req.params.jobId).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found' });
    const data = snap.data();
    return res.json({
      jobId: data.jobId,
      status: data.status,
      reportId: data.reportId || null,
      error: data.error || null
    });
  } catch (e) {
    console.error('get job error:', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// NEW: DELETE /jobs/:jobId (best-effort UI stub)
// Marks the job as user-deleted; bucket lifecycle will handle object deletion.
app.delete('/jobs/:jobId', async (req, res) => {
  try {
    const ref = jobsCol.doc(req.params.jobId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found' });

    await ref.update({
      userDeleted: true,
      status: 'user_deleted',
      updatedAt: Firestore.FieldValue.serverTimestamp()
    });

    return res.json({ ok: true, jobId: req.params.jobId });
  } catch (e) {
    console.error('delete job error:', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// GET /reports/:reportId -> JSON report (full payload saved by worker)
app.get('/reports/:reportId', async (req, res) => {
  try {
    const snap = await reportsCol.doc(req.params.reportId).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found' });
    const data = snap.data();
    // We store { json: <report> } — return the JSON directly
    return res.json(data.json);
  } catch (e) {
    console.error('get report error:', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// POST /delete-all  { userId }
app.post('/delete-all', async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });

    // Delete reports
    const reps = await reportsCol.where('userId', '==', userId).get();
    const batch = firestore.batch();
    reps.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    // Mark jobs as userDeleted
    const jobs = await jobsCol.where('userId', '==', userId).get();
    const batch2 = firestore.batch();
    jobs.forEach(doc => batch2.update(doc.ref, {
      userDeleted: true,
      updatedAt: Firestore.FieldValue.serverTimestamp()
    }));
    await batch2.commit();

    return res.json({ ok: true });
  } catch (e) {
    console.error('delete-all error:', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Admin sweeper (simple flag flipper; bucket lifecycle handles actual object TTL)
app.get('/admin/sweeper', async (_req, res) => {
  try {
    const q = await reportsCol.where('images_deleted', '==', false).limit(20).get();
    for (const doc of q.docs) {
      const r = doc.data();
      const created = r.createdAt?.toDate?.() || new Date(Date.now() - 2 * 60 * 60 * 1000);
      if (Date.now() - created.getTime() > 60 * 60 * 1000) {
        await doc.ref.update({ images_deleted: true, updatedAt: Firestore.FieldValue.serverTimestamp() });
      }
    }
    res.json({ swept: q.size });
  } catch (e) {
    console.error('sweeper error:', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// -------------------------
// Start
// -------------------------
app.listen(PORT, () => {
  console.log(`API listening on ${PORT}`);
  console.log(`Project: ${PROJECT_ID} • Region: ${REGION} • Bucket: ${UPLOAD_BUCKET} • Topic: ${PUBSUB_TOPIC}`);
});
