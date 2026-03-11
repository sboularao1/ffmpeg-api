const express = require('express');
const fetch = require('node-fetch');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const app = express();
app.use(express.json({ limit: '50mb' }));

app.post('/merge', async (req, res) => {
  const { videoUrl, text, language } = req.body;

  const videoPath = '/tmp/video.mp4';
  const audioPath = '/tmp/audio.mp3';
  const outputPath = '/tmp/final.mp4';

  const voiceMap = {
    'arabic': 'ar-EG-SalmaNeural',
    'french': 'fr-FR-DeniseNeural',
    'english': 'en-US-JennyNeural'
  };

  const voice = voiceMap[language?.toLowerCase()] || 'en-US-JennyNeural';

  try {
    const videoRes = await fetch(videoUrl);
    fs.writeFileSync(videoPath, Buffer.from(await videoRes.arrayBuffer()));
    console.log('Video downloaded');

    const safeText = text.replace(/[^a-zA-Z0-9\s.,!?'-]/g, ' ').replace(/\s+/g, ' ').trim();
    await execAsync(`python3 -m edge_tts --voice ${voice} --text "${safeText}" --write-media ${audioPath}`);
    console.log('Audio generated');
const audioSize = fs.statSync(audioPath).size;
console.log('Audio file size:', audioSize);
    
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions(['-shortest'])
      .save(outputPath)
      .on('start', (cmd) => {
        console.log('FFmpeg started:', cmd);
      })
      .on('end', () => {
        console.log('FFmpeg finished');
        const finalVideo = fs.readFileSync(outputPath);
        res.setHeader('Content-Type', 'video/mp4');
        res.send(finalVideo);
      })
      .on('error', (err) => {
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
