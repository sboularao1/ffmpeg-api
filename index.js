const express = require('express');
const fetch = require('node-fetch');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const app = express();
app.use(express.json({ limit: '50mb' }));

// دمج فيديو واحد مع صوت section واحد
app.post('/merge-section', async (req, res) => {
  const { videoUrl, text, language, order } = req.body;

  const videoPath = `/tmp/video_${order}.mp4`;
  const audioPath = `/tmp/audio_${order}.mp3`;
  const outputPath = `/tmp/section_${order}.mp4`;

  const voiceMap = {
    'arabic': 'ar-EG-SalmaNeural',
    'french': 'fr-FR-DeniseNeural',
    'english': 'en-US-JennyNeural'
  };
  const voice = voiceMap[language?.toLowerCase()] || 'en-US-JennyNeural';

  try {
    // تحميل الفيديو
    const videoRes = await fetch(videoUrl);
    fs.writeFileSync(videoPath, Buffer.from(await videoRes.arrayBuffer()));
    console.log(`Section ${order} video downloaded`);

    // توليد الصوت
    const safeText = text.replace(/[^a-zA-Z0-9\u0600-\u06FF\s.,!?'-]/g, ' ').replace(/\s+/g, ' ').trim();
    await execAsync(`python3 -m edge_tts --voice ${voice} --text "${safeText}" --write-media ${audioPath}`);
    console.log(`Section ${order} audio generated`);

    // دمج الفيديو مع الصوت
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions(['-shortest', '-map 0:v:0', '-map 1:a:0', '-c:v libx264', '-c:a aac', '-strict experimental'])
      .save(outputPath)
      .on('end', () => {
        console.log(`Section ${order} merged`);
        const sectionVideo = fs.readFileSync(outputPath);
        res.setHeader('Content-Type', 'video/mp4');
        res.send(sectionVideo);
      })
      .on('error', err => {
        console.log(`Section ${order} error:`, err.message);
        res.status(500).json({ error: err.message });
      });

  } catch (err) {
    console.log('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// دمج كل المقاطع في فيديو واحد
app.post('/concat', async (req, res) => {
  const { videos } = req.body; // قائمة base64 videos

  try {
    const videoPaths = [];
    for (let i = 0; i < videos.length; i++) {
      const videoPath = `/tmp/concat_${i}.mp4`;
      fs.writeFileSync(videoPath, Buffer.from(videos[i], 'base64'));
      videoPaths.push(videoPath);
    }

    const concatPath = '/tmp/concat.txt';
    const outputPath = '/tmp/final.mp4';
    const concatContent = videoPaths.map(v => `file '${v}'`).join('\n');
    fs.writeFileSync(concatPath, concatContent);

    await execAsync(`ffmpeg -y -f concat -safe 0 -i ${concatPath} -c:v libx264 -c:a aac ${outputPath}`);
    console.log('Final video ready');

    const finalVideo = fs.readFileSync(outputPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.send(finalVideo);

  } catch (err) {
    console.log('Concat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg API running on port ${PORT}`));
