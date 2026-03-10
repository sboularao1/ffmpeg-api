const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const fetch = require('node-fetch');

const app = express();
app.use(express.json({ limit: '50mb' }));

app.post('/merge', async (req, res) => {
  const { videoUrl, audioBase64, mimeType } = req.body;
    
      const videoPath = '/tmp/video.mp4';
        const audioPath = '/tmp/audio.wav';
          const outputPath = '/tmp/final.mp4';

            try {
                const videoRes = await fetch(videoUrl);
                    fs.writeFileSync(videoPath, Buffer.from(await videoRes.arrayBuffer()));
                        
                            const audioBuffer = Buffer.from(audioBase64, 'base64');
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
                                                                                                              res.status(500).json({ error: err.message });
                                                                                                                    });
                                                                                                                      } catch (err) {
                                                                                                                          res.status(500).json({ error: err.message });
                                                                                                                            }
                                                                                                                            });

                                                                                                                            const PORT = process.env.PORT || 3000;
                                                                                                                            app.listen(PORT, () => console.log(`FFmpeg API running on port ${PORT}`));