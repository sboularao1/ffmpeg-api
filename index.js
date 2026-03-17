const express = require('express');
const fetch = require('node-fetch');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const app = express();
app.use(express.json({ limit: '50mb' }));

// ===== START: Lightpanda scraper endpoint =====
const { chromium } = require('@lightpanda/browser');

app.post('/scrape', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }

  console.log(`[scrape] fetching: ${url}`);

  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // استخراج النص الخام من الصفحة
    const content = await page.evaluate(() => {
      // حذف العناصر غير المفيدة
      const remove = ['script', 'style', 'nav', 'footer', 'header', 'aside', 'iframe'];
      remove.forEach(tag => {
        document.querySelectorAll(tag).forEach(el => el.remove());
      });
      return document.body?.innerText || document.body?.textContent || '';
    });

    // تنظيف النص
    const clean = content
      .replace(/\s+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 8000); // Groq يقبل حتى ~8000 كلمة

    console.log(`[scrape] done, length=${clean.length}`);
    res.json({ content: clean, source: url });

  } catch (err) {
    console.log(`[scrape] error: ${err.message}`);
    res.status(500).json({ error: err.message, source: url });
  } finally {
    if (browser) await browser.close();
  }
});
// ===== END: Lightpanda scraper endpoint =====
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

// ✅ حفظ section واحد — الطبقة 1: background + TTS audio
app.post('/save-section', async (req, res) => {
  const {
    order,
    text,
    language,
    background,
    on_screen_text,
    overlay_image,
    diagram,
    sfx,
    music,
    voice: requestedVoice,
    tts_engine,
    music_url
  } = req.body;

  console.log(`[save-section] order=${order} language=${language}`);

  const videoPath = `/tmp/bg_${order}.mp4`;
  const imagePath = `/tmp/bg_${order}.jpg`;
  const audioPath = `/tmp/audio_${order}.mp3`;
  const musicPath = `/tmp/music_${order}.mp3`;
  const outputPath = `/tmp/section_${order}.mp4`;

  const voiceMap = {
    'arabic': 'ar-EG-SalmaNeural',
    'french': 'fr-FR-DeniseNeural',
    'english': 'en-US-JennyNeural'
  };
  const voice = requestedVoice || voiceMap[language?.toLowerCase()] || 'en-US-JennyNeural';
  const engine = (language?.toLowerCase() === 'arabic') ? 'edge' : (tts_engine || 'edge');

  try {
    // 1. تنظيف النص
    const safeText = text
      .replace(/[^\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\w\s.,!?'-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // 2. توليد الصوت — Kokoro أو Edge-TTS
    const generateTTS = async () => {
      if (engine === 'kokoro' && process.env.KOKORO_API_URL) {
        try {
          const kokoroRes = await fetch(`${process.env.KOKORO_API_URL}/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: safeText, voice }),
            signal: AbortSignal.timeout(15000)
          });
          if (kokoroRes.ok) {
            const wavPath = audioPath.replace('.mp3', '.wav');
            fs.writeFileSync(wavPath, Buffer.from(await kokoroRes.arrayBuffer()));
            await execAsync(`ffmpeg -y -i ${wavPath} ${audioPath}`);
            console.log(`[TTS] Kokoro ✅ voice=${voice}`);
            return;
          }
        } catch (e) {
          console.log(`[TTS] Kokoro failed → Edge-TTS fallback: ${e.message}`);
        }
      }
      // Edge-TTS (default + fallback)
      await execAsync(`python3 -m edge_tts --voice ${voice} --text "${safeText}" --write-media ${audioPath}`);
      console.log(`[TTS] Edge-TTS ✅ voice=${voice}`);
    };

    await generateTTS();

    const { stdout } = await execAsync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 ${audioPath}`);
    const audioDuration = parseFloat(stdout.trim());
    console.log(`[save-section] audio duration: ${audioDuration}s`);
    console.log(`[save-section] text length: ${safeText.length} chars`);

    // 2.5 تحميل الموسيقى إذا وجدت
    let musicBuffer = null;
    if (music_url) {
      try {
        musicBuffer = await new Promise((resolve, reject) => {
          const downloadFile = (url, redirectCount = 0) => {
            if (redirectCount > 5) return reject(new Error('Too many redirects'));
            const protocol = url.startsWith('https') ? require('https') : require('http');
            protocol.get(url, (response) => {
              if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 303) {
                return downloadFile(response.headers.location, redirectCount + 1);
              }
              if (response.statusCode !== 200) return reject(new Error(`HTTP ${response.statusCode}`));
              const chunks = [];
              response.on('data', chunk => chunks.push(chunk));
              response.on('end', () => resolve(Buffer.concat(chunks)));
              response.on('error', reject);
            }).on('error', reject);
          };
          downloadFile(music_url);
        });
        fs.writeFileSync(musicPath, musicBuffer);
        console.log(`[save-section] music downloaded ✅`);
      } catch (e) {
        console.log(`[save-section] music download failed ⚠️ ${e.message}`);
        musicBuffer = null;
      }
    }

    // 3. تحميل الـ background مع دعم redirects
    const bgBuffer = await new Promise((resolve, reject) => {
      // إذا كان الرابط من Unsplash نعامله كصورة دائماً
      if (background.url.includes('unsplash.com')) {
        background.type = 'image';
      }
      const downloadFile = (url, redirectCount = 0) => {
        if (redirectCount > 5) return reject(new Error('Too many redirects'));
        const protocol = url.startsWith('https') ? require('https') : require('http');
        protocol.get(url, (response) => {
          // تتبع الـ redirect تلقائياً
          if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 303) {
            return downloadFile(response.headers.location, redirectCount + 1);
          }
          if (response.statusCode !== 200) {
            console.log(`[save-section] download failed: ${response.statusCode} for URL: ${url}`);
            return reject(new Error(`HTTP ${response.statusCode} for ${url}`));
          }
          const chunks = [];
          response.on('data', chunk => chunks.push(chunk));
          response.on('end', () => resolve(Buffer.concat(chunks)));
          response.on('error', reject);
        }).on('error', reject);
      };
      downloadFile(background.url);
    });

    if (background.type === 'video') {
      // background فيديو — يتكرر حتى ينتهي الصوت
      fs.writeFileSync(videoPath, bgBuffer);

      // تطبيق Ken Burns + Fade + Color Grading بـ MoviePy
      // ⚠️ معلّق — MoviePy بطيء على Render free tier
      // try {
      //   await execAsync(`python3 process.py ${videoPath} ${processedPath} video ${audioDuration} ""`);
      //   console.log(`[save-section] MoviePy ✅ order=${order}`);
      // } catch (e) {
      //   console.log(`[save-section] MoviePy failed, using FFmpeg ⚠️ ${e.message}`);
      //   fs.copyFileSync(videoPath, processedPath);
      // }

      await new Promise((resolve, reject) => {
        const cmd = ffmpeg()
          .input(videoPath)
          .inputOptions([])
          .input(audioPath);

        if (musicBuffer) {
          cmd.input(musicPath)
  .inputOptions(['-stream_loop -1'])
  .outputOptions([
    `-t ${audioDuration}`,
    '-filter_complex', `[1:a]volume=1[tts];[2:a]volume=0.15[music];[tts][music]amix=inputs=2:duration=first[aout]`,
    '-map 0:v:0',
    '-map [aout]',
              '-c:v libx264',
              '-crf 35',
              '-preset ultrafast',
              '-vf scale=640:360,fps=30',
              '-r 30',
              '-c:a aac',
              '-strict experimental'
            ]);
        } else {
          cmd.outputOptions([
            `-t ${audioDuration}`,
            '-map 0:v:0',
            '-map 1:a:0',
            '-c:v libx264',
            '-crf 35',
            '-preset ultrafast',
            '-vf scale=640:360,fps=30',
            '-r 30',
            '-c:a aac',
            '-strict experimental'
          ]);
        }

        cmd.save(outputPath)
          .on('end', resolve)
          .on('error', reject);
      });

    } else {
      // background صورة — تبقى ثابتة طول مدة الصوت
      fs.writeFileSync(imagePath, bgBuffer);

      // تطبيق Ken Burns + Fade + Color Grading بـ MoviePy
      // ⚠️ معلّق — MoviePy بطيء على Render free tier
      // try {
      //   await execAsync(`python3 process.py ${imagePath} ${processedPath} image ${audioDuration} ""`);
      //   console.log(`[save-section] MoviePy ✅ order=${order}`);
      // } catch (e) {
      //   console.log(`[save-section] MoviePy failed, using FFmpeg ⚠️ ${e.message}`);
      // }

      await new Promise((resolve, reject) => {
        const cmd = ffmpeg()
          .input(imagePath)
          .input(audioPath);

        if (musicBuffer) {
          cmd.input(musicPath)
  .inputOptions(['-stream_loop -1'])
  .outputOptions([
    `-t ${audioDuration}`,
    '-filter_complex', `[1:a]volume=1[tts];[2:a]volume=0.15[music];[tts][music]amix=inputs=2:duration=first[aout]`,
    '-map 0:v:0',
    '-map [aout]',
              '-c:v libx264',
              '-crf 35',
              '-preset ultrafast',
              '-vf scale=640:360,fps=30',
              '-r 30',
              '-pix_fmt yuv420p',
              '-c:a aac',
              '-strict experimental'
            ]);
        } else {
          cmd.outputOptions([
            `-t ${audioDuration}`,
            '-map 0:v:0',
            '-map 1:a:0',
            '-c:v libx264',
            '-crf 35',
            '-preset ultrafast',
            '-vf scale=640:360,fps=30',
            '-r 30',
            '-pix_fmt yuv420p',
            '-c:a aac',
            '-strict experimental'
          ]);
        }

        cmd.save(outputPath)
          .on('end', resolve)
          .on('error', reject);
      });
    }

    console.log(`[save-section] done, size=${fs.statSync(outputPath).size}`);
    res.json({ success: true, order });

  } catch (err) {
    console.log(`[save-section] error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ✅ دمج كل الـ sections المحفوظة في /tmp في فيديو واحد نهائي
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

    await execAsync(`ffmpeg -y -f concat -safe 0 -i ${concatPath} -c:v libx264 -crf 35 -preset ultrafast -vf "scale=640:360,fps=30" -r 30 -c:a aac -async 1 ${outputPath}`);
    const finalSize = fs.statSync(outputPath).size;
    console.log(`[concat-saved] final video ready, size=${finalSize}`);

    res.json({ success: true, size: finalSize, download: '/download-final' });

  } catch (err) {
    console.log(`[concat-saved] error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ✅ تحميل الفيديو النهائي
app.get('/download-final', (req, res) => {
  const outputPath = '/tmp/final.mp4';
  if (fs.existsSync(outputPath)) {
    const video = fs.readFileSync(outputPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="final.mp4"');
    res.send(video);
  } else {
    res.status(404).json({ error: 'Final video not found' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg API running on port ${PORT}`));
