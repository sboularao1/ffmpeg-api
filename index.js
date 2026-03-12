const express = require('express');
const fetch = require('node-fetch');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const app = express();
app.use(express.json({ limit: '50mb' }));

// ✅ Health check — لـ UptimeRobot
app.get('/', (req, res) => res.json({ status: 'ok' }));

// ✅ فحص الـ sections المحفوظة في /tmp
app.get('/check-sections', (req, res) => {
  try {
    const files = fs.readdirSync('/tmp').filter(f => f.startsWith('section_'));
    const sections = files.map(f => {
      const order = f.replace('section_', '').replace('.mp4', '');
      const size = fs.statSync(`/tmp/${f}`).size;
      return { order, size };
    });
    res.json({ sections, count: sections.length });
  } catch (err) {
    res.json({ sections: [], count: 0 });
  }
});

// ✅ مشاهدة section واحد للتحقق
app.get('/get-section/:order', (req, res) => {
  const order = req.params.order;
  const sectionPath = `/tmp/section_${order}.mp4`;
  if (fs.existsSync(sectionPath)) {
    const video = fs.readFileSync(sectionPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.send(video);
  } else {
    res.status(404).json({ error: 'Section not found' });
  }
});

// ✅ حفظ section واحد (فيديو + صوت) في /tmp
// يُستدعى من Loop في n8n — يرجع { success: true, order: N }
app.post('/save-section', async (req, res) => {
  const { videoUrl, text, language, order } = req.body;
  console.log(`[save-section] order=${order} language=${language}`);
  console.log(`[save-section] videoUrl=${videoUrl}`);

  const videoPath = `/tmp/video_${order}.mp4`;
  const audioPath = `/tmp/audio_${order}.mp3`;
  const outputPath = `/tmp/section_${order}.mp4`;

  const voiceMap = {
    'arabic': 'ar-EG-SalmaNeural',
    'french': 'fr-FR-DeniseNeural',
    'english': 'en-US-JennyNeural'
  };
  const voice = voiceMap[language?.toLowerCase()] || 'en-US-JennyNeural';
  console.log(`[save-section] voice=${voice}`);

  try {
    // 1. تحميل الفيديو
    const videoRes = await fetch(videoUrl);
    fs.writeFileSync(videoPath, Buffer.from(await videoRes.arrayBuffer()));
    console.log(`[save-section] video downloaded, size=${fs.statSync(videoPath).size}`);

    // 2. تنظيف النص — يدعم العربية والإنجليزية والفرنسية
    const safeText = text
      .replace(/[^\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\w\s.,!?'-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // 3. توليد الصوت
    await execAsync(`python3 -m edge_tts --voice ${voice} --text "${safeText}" --write-media ${audioPath}`);
    const audioSize = fs.statSync(audioPath).size;
    console.log(`[save-section] audio generated, size=${audioSize}`);

    // 4. دمج الفيديو مع الصوت
    // -stream_loop -1 : يكرر الفيديو لا نهائياً
    // بدون -shortest : الفيديو يتوقف عند انتهاء الصوت وليس العكس
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(videoPath)
        .inputOptions(['-stream_loop -1'])
        .input(audioPath)
        .outputOptions([
          '-map 0:v:0',
          '-map 1:a:0',
          '-c:v libx264',
          '-crf 28',
          '-preset ultrafast',
          '-c:a aac',
          '-strict experimental'
        ])
        .save(outputPath)
        .on('start', cmd => console.log(`[save-section] FFmpeg cmd: ${cmd}`))
        .on('end', () => {
          console.log(`[save-section] section ${order} saved, size=${fs.statSync(outputPath).size}`);
          resolve();
        })
        .on('error', reject);
    });

    res.json({ success: true, order: order });

  } catch (err) {
    console.log(`[save-section] error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ✅ دمج كل الـ sections المحفوظة في /tmp في فيديو واحد نهائي
// يُستدعى من Merge Video في n8n — يرجع الفيديو النهائي
app.post('/concat-saved', async (req, res) => {
  const { orders } = req.body;
  console.log(`[concat-saved] orders=${JSON.stringify(orders)}`);

  try {
    const concatPath = '/tmp/concat.txt';
    const outputPath = '/tmp/final.mp4';

    // التحقق من وجود كل الملفات
    for (const o of orders) {
      const p = `/tmp/section_${o}.mp4`;
      if (!fs.existsSync(p)) {
        console.log(`[concat-saved] missing: ${p}`);
        return res.status(400).json({ error: `Section ${o} not found in /tmp` });
      }
    }

    const concatContent = orders.map(o => `file '/tmp/section_${o}.mp4'`).join('\n');
    fs.writeFileSync(concatPath, concatContent);
    console.log(`[concat-saved] concat.txt:\n${concatContent}`);

    await execAsync(`ffmpeg -y -f concat -safe 0 -i ${concatPath} -c:v libx264 -crf 28 -preset ultrafast -c:a aac ${outputPath}`);
    const finalSize = fs.statSync(outputPath).size;
    console.log(`[concat-saved] final video ready, size=${finalSize}`);

    const finalVideo = fs.readFileSync(outputPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.send(finalVideo);

  } catch (err) {
    console.log(`[concat-saved] error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg API running on port ${PORT}`));
