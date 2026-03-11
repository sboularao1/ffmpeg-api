const express = require('express');
const fetch = require('node-fetch');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const app = express();
app.use(express.json({ limit: '50mb' }));

const PEXELS_API_KEY = process.env.PEXELS_API_KEY;

async function fetchPexelsVideo(query) {
  const res = await fetch(
    `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=3`,
    { headers: { Authorization: PEXELS_API_KEY } }
  );
  const data = await res.json();
  return data.videos[0]?.video_files[0]?.link || null;
}

async function downloadFile(url, path) {
  const res = await fetch(url);
  fs.writeFileSync(path, Buffer.from(await res.arrayBuffer()));
}

app.post('/merge', async (req, res) => {
  const { sections, fullText, language } = req.body;

  const voiceMap = {
    'arabic': 'ar-EG-SalmaNeural',
    'french': 'fr-FR-DeniseNeural',
    'english': 'en-US-JennyNeural'
  };
  const voice = voiceMap[language?.toLowerCase()] || 'en-US-JennyNeural';

  try {
    // 1. توليد الصوت الكامل
    const audioPath = '/tmp/audio.mp3';
    const safeText = fullText.replace(/[^a-zA-Z0-9\u0600-\u06FF\s.,!?'-]/g, ' ').replace(/\s+/g, ' ').trim();
    await execAsync(`python3 -m edge_tts --voice ${voice} --text "${safeText}" --write-media ${audioPath}`);
    console.log('Audio generated, size:', fs.statSync(audioPath).size);

    // 2. جلب وتحميل فيديو لكل section
    const videoPaths = [];
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      const videoUrl = await fetchPexelsVideo(section.visual);
      if (videoUrl) {
        const videoPath = `/tmp/section_${i}.mp4`;
        await downloadFile(videoUrl, videoPath);
        videoPaths.push({ path: videoPath, duration: section.duration });
        console.log(`Section ${i + 1} downloaded`);
      }
    }

    // 3. دمج الفيديوهات مع تحديد المدة لكل section
    const concatPath = '/tmp/concat.txt';
    const mergedVideoPath = '/tmp/merged_video.mp4';
    
    // إنشاء ملف concat
    const concatContent = videoPaths.map(v => `file '${v.path}'\nduration ${v.duration}`).join('\n');
    fs.writeFileSync(concatPath, concatContent);

    await execAsync(`ffmpeg -y -f concat -safe 0 -i ${concatPath} -c:v libx264 -r 30 ${mergedVideoPath}`);
    console.log('Videos merged');

    // 4. دمج الفيديو مع الصوت
    const outputPath = '/tmp/final.mp4';
    ffmpeg()
      .input(mergedVideoPath)
      .input(audioPath)
      .outputOptions(['-shortest', '-map 0:v:0', '-map 1:a:0', '-c:v copy', '-c:a aac', '-strict experimental'])
      .save(outputPath)
      .on('start', cmd => console.log('FFmpeg final:', cmd))
      .on('end', () => {
        console.log('Final video ready, size:', fs.statSync(outputPath).size);
        const finalVideo = fs.readFileSync(outputPath);
        res.setHeader('Content-Type', 'video/mp4');
        res.send(finalVideo);
      })
      .on('error', err => {
        console.log('FFmpeg error:', err.message);
        res.status(500).json({ error: err.message });
      });

  } catch (err) {
    console.log('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg API running on port ${PORT}`));
