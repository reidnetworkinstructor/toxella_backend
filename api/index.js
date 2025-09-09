const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Storage } = require('@google-cloud/storage');
const { PubSub } = require('@google-cloud/pubsub');
const { Firestore } = require('@google-cloud/firestore');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '2mb' }));

// Env
const PORT = process.env.PORT || 8080;
const PROJECT_ID = process.env.PROJECT_ID;
const REGION = process.env.REGION || 'us-central1';
const UPLOAD_BUCKET = process.env.UPLOAD_BUCKET;
const PUBSUB_TOPIC = process.env.PUBSUB_TOPIC || 'analyze-jobs';
const FREE_MAX = parseInt(process.env.FREE_MAX_IMAGES || '3', 10);
const PRO_MAX = parseInt(process.env.PRO_MAX_IMAGES || '15', 10);

// Clients
const storage = new Storage();
const firestore = new Firestore();
const pubsub = new PubSub();

const jobsCol = firestore.collection('jobs');
const reportsCol = firestore.collection('reports');

function maxForPlan(plan) {
  return plan === 'pro' ? PRO_MAX : FREE_MAX;
}

async function buildSignedUploadUrls(jobId, count) {
  const expires = Date.now() + 15 * 60 * 1000; // 15m
  const urls = [];
  for (let i = 0; i < count; i++) {
    const path = `uploads/${jobId}/${i}.jpg`;
    const [url] = await storage
      .bucket(UPLOAD_BUCKET)
      .file(path)
      .getSignedUrl({
        action: 'write',
        version: 'v4',
        expires,
        contentType: 'application/octet-stream'
      });
    urls.push({ path, uploadUrl: url, contentType: 'application/octet-stream' });
  }
  return urls;
}

// POST /signed-urls  { plan:"free"|"pro", count:Number? } -> { jobId, urls:[...] }
app.post('/signed-urls', async (req, res) => {
  try {
    const { plan = 'free', count = 1 } = req.body || {};
    const limit = maxForPlan(plan);
    if (typeof count !== 'number' || count < 1 || count > limit) {
      return res.status(400).json({ error: `count must be 1..${limit} for plan=${plan}` });
    }
    const jobId = uuidv4();
    const urls = await buildSignedUploadUrls(jobId, count);
    return res.json({ jobId, urls, limit });
  } catch (e) {
    console.error('signed-urls error', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// POST /jobs  { jobId, plan, files:[{path,size,mime}], userId? }
app.post('/jobs', async (req, res) => {
  try {
    const { jobId, plan = 'free', files = [], userId = null } = req.body || {};
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
      status: 'uploaded',
      createdAt: Firestore.FieldValue.serverTimestamp(),
      updatedAt: Firestore.FieldValue.serverTimestamp()
    });
    // Publish to Pub/Sub
    const dataBuffer = Buffer.from(JSON.stringify({ jobId }));
    await pubsub.topic(PUBSUB_TOPIC).publishMessage({ data: dataBuffer });
    return res.json({ jobId, status: 'queued' });
  } catch (e) {
    console.error('create job error', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// GET /jobs/:jobId -> {status, reportId?, error?}
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
    console.error('get job error', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// GET /reports/:reportId -> JSON report (full for debug; slice later)
app.get('/reports/:reportId', async (req, res) => {
  try {
    const snap = await reportsCol.doc(req.params.reportId).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found' });
    const data = snap.data();
    return res.json(data.json);
  } catch (e) {
    console.error('get report error', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// POST /delete-all  { userId }
app.post('/delete-all', async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const reps = await reportsCol.where('userId', '==', userId).get();
    const batch = firestore.batch();
    reps.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    const jobs = await jobsCol.where('userId', '==', userId).get();
    const batch2 = firestore.batch();
    jobs.forEach(doc => batch2.update(doc.ref, { userDeleted: true }));
    await batch2.commit();

    return res.json({ ok: true });
  } catch (e) {
    console.error('delete-all error', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Admin sweeper (simple flag flipper; bucket lifecycle handles real deletion)
app.get('/admin/sweeper', async (_req, res) => {
  try {
    const q = await reportsCol.where('images_deleted', '==', false).limit(20).get();
    for (const doc of q.docs) {
      const r = doc.data();
      const created = r.createdAt?.toDate?.() || new Date(Date.now() - 7200000);
      if (Date.now() - created.getTime() > 60 * 60 * 1000) {
        await doc.ref.update({ images_deleted: true, updatedAt: Firestore.FieldValue.serverTimestamp() });
      }
    }
    res.json({ swept: q.size });
  } catch (e) {
    console.error('sweeper error', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.listen(PORT, () => console.log(`API listening on ${PORT}`));
