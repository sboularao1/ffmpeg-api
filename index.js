const express = require('express');
const fetch = require('node-fetch');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '50mb' }));

app.post('/merge', async (req, res) => {
  const { videoUrl, audioUrl } = req.body;

  const videoPath = '/tmp/video.mp4';
  const audioPath = '/tmp/audio.mp3';
  const outputPath = '/tmp/final.mp4';

  try {
    const videoRes = await fetch(videoUrl);
    const videoBuffer = Buffer.from(await videoRes.arrayBuffer());
    console.log('Video size:', videoBuffer.length);
    fs.writeFileSync(videoPath, videoBuffer);

    const audioRes = await fetch(audioUrl);
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
    console.log('Audio size:', audioBuffer.length);
    console.log('Audio first bytes:', audioBuffer.slice(0, 10).toString());
    fs.writeFileSync(audioPath, audioBuffer);

    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions('-shortest')
      .save(outputPath)
      .on('end', () => {
        const finalVideo = fs.readFileSync(outputPath);
        res.setHeader('Content-Type', 'video/mp4');
        res.send(finalVideo);
      })
      .on('error', (err) => {
        console.log('FFmpeg error:', err.message);
        res.status(500).json({ error: err.message });
      });
  } catch (err) {
    console.log('Catch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg API running on port ${PORT}`));
