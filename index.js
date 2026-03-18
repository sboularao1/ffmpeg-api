const express = require('express');
const fetch = require('node-fetch');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const app = express();
app.use(express.json({ limit: '50mb' }));

// ================================================================
// FONTS — تحميل تلقائي من Google Fonts
// ================================================================

const FONTS_DIR = '/tmp/fonts';

// ===== START: FONTS URLs المُصحَّحة نهائياً =====
const FONTS = {
  cairo: { file: 'Cairo-900.ttf', url: 'https://cdn.jsdelivr.net/fontsource/fonts/cairo@latest/arabic-900-normal.ttf' },
  tajawal:    { file: 'Tajawal-Regular.ttf',   url: 'https://github.com/google/fonts/raw/main/ofl/tajawal/Tajawal-Regular.ttf' },
  almarai:    { file: 'Almarai-Bold.ttf',      url: 'https://github.com/google/fonts/raw/main/ofl/almarai/Almarai-Bold.ttf' },
  montserrat: { file: 'Montserrat-Bold.ttf',   url: 'https://github.com/JulietaUla/Montserrat/raw/master/fonts/ttf/Montserrat-Bold.ttf' },
  poppins:    { file: 'Poppins-SemiBold.ttf',  url: 'https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-SemiBold.ttf' }
};
// ===== END: FONTS URLs المُصحَّحة نهائياً =====

const ensureFonts = async () => {
  if (!fs.existsSync(FONTS_DIR)) fs.mkdirSync(FONTS_DIR, { recursive: true });
  for (const [name, font] of Object.entries(FONTS)) {
    const fontPath = path.join(FONTS_DIR, font.file);
    if (!fs.existsSync(fontPath)) {
      console.log(`[fonts] downloading ${name}...`);
      try {
        const res = await fetch(font.url, { signal: AbortSignal.timeout(15000) });
        if (res.ok) {
          fs.writeFileSync(fontPath, Buffer.from(await res.arrayBuffer()));
          console.log(`[fonts] ${name} ✅`);
        } else {
          console.log(`[fonts] ${name} failed: HTTP ${res.status}`);
        }
      } catch (e) {
        console.log(`[fonts] ${name} error: ${e.message}`);
      }
    }
  }
};

ensureFonts();

// ===== START: getFont بناءً على اللغة =====
const getFont = (nameOrLang) => {
  const langMap = {
    'arabic':  'cairo',
    'english': 'montserrat',
    'french':  'poppins'
  };
  const key = langMap[nameOrLang] || nameOrLang || 'cairo';
  return path.join(FONTS_DIR, FONTS[key]?.file || FONTS.cairo.file);
};
// ===== START: generateASS — إنجليزي/فرنسي =====
const generateASS = (text, audioDuration, fontFile, language) => {
  const sentences = text
    .split(/(?<=[.!?,;])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 2);

  if (!sentences.length) return null;

  const totalWords = text.split(/\s+/).length;
  const fontName = language === 'french' ? 'Poppins SemiBold' : 'Montserrat Bold';
  const safeFontFile = fontFile.replace(/\\/g, '/');

  const fmt = (t) => {
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const cs = Math.floor((t % 1) * 100);
    return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
  };

  let assContent = `[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},20,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,2,20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  let currentTime = 0;
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/).length;
    const duration = (words / totalWords) * audioDuration;
    const end = Math.min(currentTime + duration + 0.3, audioDuration - 0.1);
    const cleanText = sentence.replace(/\{/g,'').replace(/\}/g,'').replace(/\n/g,' ');
    assContent += `Dialogue: 0,${fmt(currentTime)},${fmt(end)},Default,,0,0,0,,${cleanText}\n`;
    currentTime = end + 0.05;
  }

  const assPath = `/tmp/subs_${Date.now()}.ass`;
  fs.writeFileSync(assPath, assContent, 'utf8');
  return assPath;
};
// ===== END: generateASS — إنجليزي/فرنسي =====


// ===== END: getFont بناءً على اللغة =====

// ================================================================
// BUILD VIDEO FILTERS — كل تأثيرات FFmpeg
// ================================================================

/**
 * effects object:
 *   ken_burns: bool         — zoom تدريجي (للصور فقط)
 *   ken_burns_dir: 'in'|'out'
 *   fade: bool              — fade in/out
 *   fade_duration: float    — مدة الـ fade (default 0.5s)
 *   color_grade: bool       — تحسين الألوان
 *   brightness: float       — (default 0.06)
 *   contrast: float         — (default 1.1)
 *   saturation: float       — (default 1.2)
 *   hue_shift: bool         — تحويل اللون السينمائي
 *   vignette: bool          — إظلام الحواف
 *   vignette_angle: float   — (default PI/4)
 *   blur: bool              — Gaussian blur
 *   blur_sigma: float       — (default 2)
 *   sharpen: bool           — تحسين الحدة
 *   film_grain: bool        — حبيبات الفيلم
 *   chromatic: bool         — Chromatic aberration
 *   speed: float            — سرعة الفيديو (0.5=slow, 2.0=fast)
 *   lower_third: bool       — نص أسفل الشاشة
 *   lower_third_text: str
 *   lower_third_font: 'cairo'|'tajawal'|'almarai'
 *   lower_third_fontsize: int
 *   title_card: bool        — نص كبير في المنتصف
 *   title_text: str
 *   title_font: str
 *   title_start: float
 *   title_duration: float
 *   title_fontsize: int
 */
const buildVideoFilters = (effects = {}, mediaType = 'video', audioDuration = 10, w = 640, h = 360) => {
  const filters = [];

  // 1. Scale + Pad
  filters.push(`scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`);

  // 2. FPS
  filters.push(`fps=30`);

  // 3. Ken Burns — للصور فقط
  if (effects.ken_burns && mediaType === 'image') {
    const d = Math.ceil(audioDuration * 30);
    if (effects.ken_burns_dir === 'out') {
      filters.push(`zoompan=z='if(lte(zoom,1.0),1.15,max(1.0,zoom-0.0015))':d=${d}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${w}x${h}`);
    } else {
      filters.push(`zoompan=z='if(lte(zoom,1.0),1.0,min(1.15,zoom+0.0015))':d=${d}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${w}x${h}`);
    }
  }

  // 4. Speed
  if (effects.speed && effects.speed !== 1.0) {
    filters.push(`setpts=${(1 / effects.speed).toFixed(2)}*PTS`);
  }

  // 5. Color Grade
  if (effects.color_grade) {
    const b = effects.brightness ?? 0.06;
    const c = effects.contrast ?? 1.1;
    const s = effects.saturation ?? 1.2;
    filters.push(`eq=brightness=${b}:contrast=${c}:saturation=${s}`);
  }

  // 6. Hue Shift
  if (effects.hue_shift) {
    filters.push(`hue=h=${effects.hue_value ?? 10}:s=1.1`);
  }

  // 7. Blur
  if (effects.blur) {
    filters.push(`gblur=sigma=${effects.blur_sigma ?? 2}`);
  }

  // 8. Sharpen
  if (effects.sharpen) {
    filters.push(`unsharp=5:5:1.5:5:5:0.0`);
  }

  // 9. Film Grain
  if (effects.film_grain) {
    filters.push(`noise=alls=8:allf=t`);
  }

  // 10. Chromatic Aberration
  if (effects.chromatic) {
    filters.push(`rgbashift=rh=2:bh=-2`);
  }

  // 11. Vignette
  if (effects.vignette) {
    filters.push(`vignette=angle=${effects.vignette_angle ?? 'PI/4'}`);
  }

  // 12. Fade in/out
  if (effects.fade) {
    const fd = effects.fade_duration ?? 0.5;
    const fadeOutStart = Math.max(0, audioDuration - fd);
    filters.push(`fade=t=in:st=0:d=${fd}`);
    filters.push(`fade=t=out:st=${fadeOutStart.toFixed(2)}:d=${fd}`);
  }

  // 13. Lower Third
  if (effects.lower_third && effects.lower_third_text) {
    const text = effects.lower_third_text.replace(/'/g, "\\'").replace(/:/g, "\\:");
    const fontFile = getFont(effects.lower_third_font || effects.language || 'cairo');
    const fontSize = effects.lower_third_fontsize ?? 28;
    const yPos = h - 70;
    filters.push(
      `drawtext=fontfile='${fontFile}':text='${text}':fontsize=${fontSize}:fontcolor=white:x=(w-text_w)/2:y=${yPos}:box=1:boxcolor=black@0.75:boxborderw=12:enable='between(t,0,${audioDuration})'`
    );
  }

  // 14. Title Card
  if (effects.title_card && effects.title_text) {
    const text = effects.title_text.replace(/'/g, "\\'").replace(/:/g, "\\:");
    const fontFile = getFont(effects.lower_third_font || effects.language || 'cairo');
    const fontSize = effects.title_fontsize ?? 48;
    const start = effects.title_start ?? 0;
    const dur = effects.title_duration ?? 2;
    filters.push(
      `drawtext=fontfile='${fontFile}':text='${text}':fontsize=${fontSize}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:shadowcolor=black@0.8:shadowx=3:shadowy=3:enable='between(t,${start},${start + dur})'`
    );
  }

  // 15. Subtitles من ملف SRT
  // ===== START: subtitles ASS filter =====
if (effects.subtitles && effects.subtitles_path && fs.existsSync(effects.subtitles_path)) {
  const safePath = effects.subtitles_path.replace(/\\/g, '/').replace(/'/g, "\\'").replace(/:/g, "\\:");
  filters.push(`subtitles='${safePath}'`);
}
// ===== END: subtitles ASS filter =====

  return filters;
};

// ================================================================
// DOWNLOAD HELPER
// ================================================================
const downloadFile = (url) => new Promise((resolve, reject) => {
  const follow = (u, redirects = 0) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    const proto = u.startsWith('https') ? require('https') : require('http');
    proto.get(u, (res) => {
      if ([301, 302, 303].includes(res.statusCode)) return follow(res.headers.location, redirects + 1);
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  };
  follow(url);
});

// ================================================================
// SCRAPER
// ================================================================
app.post('/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  console.log(`[scrape] fetching: ${url}`);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bot/1.0)' },
      signal: AbortSignal.timeout(10000)
    });
    const html = await response.text();
    const clean = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000);
    res.json({ content: clean, source: url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// HEALTH
// ================================================================
app.get('/', (req, res) => res.json({
  status: 'ok',
  fonts: Object.fromEntries(
    Object.entries(FONTS).map(([n, f]) => [n, fs.existsSync(path.join(FONTS_DIR, f.file))])
  )
}));

// ================================================================
// CHECK SECTIONS
// ================================================================
app.get('/check-sections', (req, res) => {
  try {
    const files = fs.readdirSync('/tmp').filter(f => f.startsWith('section_'));
    res.json({
      sections: files.map(f => ({ order: f.replace('section_', '').replace('.mp4', ''), size: fs.statSync(`/tmp/${f}`).size })),
      count: files.length
    });
  } catch { res.json({ sections: [], count: 0 }); }
});

app.get('/get-section/:order', (req, res) => {
  const p = `/tmp/section_${req.params.order}.mp4`;
  if (fs.existsSync(p)) { res.setHeader('Content-Type', 'video/mp4'); res.send(fs.readFileSync(p)); }
  else res.status(404).json({ error: 'Not found' });
});

// ================================================================
// TEST EFFECTS — 10 صور بتأثيرات مختلفة
// ================================================================
app.post('/test-effects', async (req, res) => {
  console.log('[test-effects] START');
  await ensureFonts();

  const testCases = [
    {
      name: '01_ken_burns_in',
      query: 'artificial intelligence neural network',
      effects: { ken_burns: true, ken_burns_dir: 'in', fade: true, color_grade: true }
    },
    {
      name: '02_ken_burns_out',
      query: 'robot arm factory automation closeup',
      effects: { ken_burns: true, ken_burns_dir: 'out', fade: true, color_grade: true }
    },
    {
      name: '03_color_grade_vignette',
      query: 'dark server room data center',
      effects: { fade: true, color_grade: true, brightness: 0.02, contrast: 1.3, saturation: 1.4, vignette: true }
    },
    {
      name: '04_lower_third_arabic',
      query: 'programmer coding dark screen',
      effects: { fade: true, color_grade: true, lower_third: true, lower_third_text: 'الذكاء الاصطناعي يغير العالم', lower_third_font: 'cairo', lower_third_fontsize: 30 }
    },
    {
      name: '05_lower_third_english',
      query: 'futuristic city smart technology',
      effects: { fade: true, color_grade: true, lower_third: true, lower_third_text: 'AI Video Copilot', lower_third_font: 'tajawal', lower_third_fontsize: 32 }
    },
    {
      name: '06_title_card_almarai',
      query: 'galaxy space stars universe',
      effects: { fade: true, color_grade: true, vignette: true, title_card: true, title_text: 'نمِّط', title_font: 'almarai', title_fontsize: 72, title_start: 0.5, title_duration: 3 }
    },
    {
      name: '07_film_grain_sharpen',
      query: 'microchip circuit board technology',
      effects: { fade: true, sharpen: true, film_grain: true, color_grade: true, contrast: 1.2 }
    },
    {
      name: '08_vignette_hue',
      query: 'vintage retro technology computer',
      effects: { fade: true, vignette: true, hue_shift: true, hue_value: 15, color_grade: true, saturation: 0.7, contrast: 1.2 }
    },
    {
      name: '09_all_effects',
      query: 'neural network visualization digital',
      effects: {
        ken_burns: true, ken_burns_dir: 'in',
        fade: true, color_grade: true, vignette: true,
        film_grain: true, sharpen: true,
        lower_third: true, lower_third_text: 'Work Less. Automate More.', lower_third_font: 'tajawal',
        title_card: true, title_text: 'نمِّط', title_font: 'almarai', title_fontsize: 64, title_start: 1, title_duration: 2.5
      }
    },
    {
      name: '10_slogan_cairo',
      query: 'automation workflow process digital',
      effects: {
        ken_burns: true, ken_burns_dir: 'in',
        fade: true, color_grade: true, brightness: 0.03, contrast: 1.15, saturation: 1.3,
        vignette: true,
        lower_third: true, lower_third_text: 'وقتك أغلى من أن تضيعه يدوياً', lower_third_font: 'cairo', lower_third_fontsize: 26
      }
    }
  ];

  const results = [];

  for (const tc of testCases) {
    console.log(`[test-effects] → ${tc.name}`);
    try {
      // تحميل صورة من Pixabay
      const pixUrl = `https://pixabay.com/api/?key=55006006-78e40023c292490b33f4eb6f1&q=${encodeURIComponent(tc.query)}&image_type=photo&per_page=3&safesearch=true`;
      const pixRes = await fetch(pixUrl, { signal: AbortSignal.timeout(10000) });
      const pixData = await pixRes.json();

      if (!pixData.hits?.length) {
        results.push({ name: tc.name, status: 'no_image' });
        continue;
      }

      const imgUrl = pixData.hits[0].largeImageURL || pixData.hits[0].webformatURL;
      const imgPath = `/tmp/test_img_${tc.name}.jpg`;
      const outPath = `/tmp/test_out_${tc.name}.mp4`;

      fs.writeFileSync(imgPath, await downloadFile(imgUrl));

      const dur = 5;
      const filters = buildVideoFilters(tc.effects, 'image', dur, 640, 360);
      const vfStr = filters.join(',');

      console.log(`[test-effects] ${tc.name} vf: ${vfStr.substring(0, 100)}...`);

      await execAsync(`ffmpeg -y -loop 1 -i "${imgPath}" -t ${dur} -vf "${vfStr}" -c:v libx264 -crf 28 -preset fast -pix_fmt yuv420p "${outPath}"`);

      const size = fs.statSync(outPath).size;
      console.log(`[test-effects] ${tc.name} ✅ ${size} bytes`);
      results.push({ name: tc.name, status: 'ok', size, download: `/test-result/${tc.name}` });

    } catch (e) {
      console.log(`[test-effects] ${tc.name} ❌ ${e.message}`);
      results.push({ name: tc.name, status: 'error', error: e.message });
    }
  }

  const success = results.filter(r => r.status === 'ok').length;
  console.log(`[test-effects] DONE ${success}/${testCases.length}`);
  res.json({ total: testCases.length, success, results });
});

// ================================================================
// GET TEST RESULT
// ================================================================
app.get('/test-result/:name', (req, res) => {
  const p = `/tmp/test_out_${req.params.name}.mp4`;
  if (fs.existsSync(p)) {
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}.mp4"`);
    res.send(fs.readFileSync(p));
  } else {
    res.status(404).json({
      error: 'Not found',
      available: fs.readdirSync('/tmp').filter(f => f.startsWith('test_out_')).map(f => f.replace('test_out_', '').replace('.mp4', ''))
    });
  }
});

// ================================================================
// SAVE SECTION
// ================================================================
app.post('/save-section', async (req, res) => {
  const {
    order, text, language, background,
    on_screen_text, overlay_image,
    voice: requestedVoice, tts_engine,
    music_url, effects: requestedEffects
  } = req.body;

  console.log(`[save-section] order=${order} language=${language}`);
  await ensureFonts();

  const videoPath  = `/tmp/bg_${order}.mp4`;
  const imagePath  = `/tmp/bg_${order}.jpg`;
  const audioPath  = `/tmp/audio_${order}.mp3`;
  const musicPath  = `/tmp/music_${order}.mp3`;
  const outputPath = `/tmp/section_${order}.mp4`;

  const voiceMap = { arabic: 'ar-EG-SalmaNeural', french: 'fr-FR-DeniseNeural', english: 'en-US-JennyNeural' };
  const voice  = requestedVoice || voiceMap[language?.toLowerCase()] || 'en-US-JennyNeural';
  const engine = language?.toLowerCase() === 'arabic' ? 'edge' : (tts_engine || 'kokoro');

  try {
    const safeText = text
      .replace(/[^\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\w\s.,!?'-]/g, ' ')
      .replace(/\s+/g, ' ').trim();

    // ===== START: generateTTS with Kokoro via Hugging Face =====
    const generateTTS = async () => {
      if (engine === 'kokoro' && process.env.KOKORO_API_URL) {
        try {
          const langCode = voice.startsWith('fr') ? 'fr-fr' : 'en-us';
          console.log(`[TTS] Kokoro → HF Space voice=${voice} lang=${langCode}`);
          const params = new URLSearchParams({ text: safeText, voice, lang: langCode });
          const kokoroRes = await fetch(
            `${process.env.KOKORO_API_URL}/tts?${params.toString()}`,
            { method: 'POST', signal: AbortSignal.timeout(60000) }
          );
          if (kokoroRes.ok) {
            const wavPath = audioPath.replace('.mp3', '.wav');
            fs.writeFileSync(wavPath, Buffer.from(await kokoroRes.arrayBuffer()));
            await execAsync(`ffmpeg -y -i ${wavPath} ${audioPath}`);
            console.log(`[TTS] Kokoro ✅ voice=${voice}`);
            return;
          }
          console.log(`[TTS] Kokoro HTTP ${kokoroRes.status}: ${await kokoroRes.text()}`);
        } catch (e) {
          console.log(`[TTS] Kokoro failed → Edge-TTS fallback: ${e.message}`);
        }
      }
      await execAsync(`python3 -m edge_tts --voice ${voice} --text "${safeText}" --write-media ${audioPath}`);
      console.log(`[TTS] Edge-TTS ✅ voice=${voice}`);
    };
    // ===== END: generateTTS with Kokoro via Hugging Face =====

    await generateTTS();

    const { stdout } = await execAsync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 ${audioPath}`);
    const audioDuration = parseFloat(stdout.trim());
    console.log(`[save-section] audio=${audioDuration}s`);

    // ===== START: توليد ASS بعد TTS =====
let assPath = null;
try {
  if (language === 'arabic') {
    // Python script للعربية
    const fontFile = getFont('cairo');
    const tempAssPath = `/tmp/subs_${Date.now()}.ass`;
    const { execSync } = require('child_process');
    execSync(`python3 generate_ass_arabic.py "${text.replace(/"/g, '\\"')}" ${audioDuration} "${fontFile}" "${tempAssPath}"`);
    assPath = tempAssPath;
  } else {
    // Node.js للإنجليزية والفرنسية
    const fontFile = getFont(language);
    assPath = generateASS(text, audioDuration, fontFile, language);
  }
} catch (e) {
  console.error('[ASS] generation failed:', e.message);
}
// ===== END: توليد ASS بعد TTS =====

    // تحميل الموسيقى
    let musicBuffer = null;
    if (music_url) {
      try {
        musicBuffer = await downloadFile(music_url);
        fs.writeFileSync(musicPath, musicBuffer);
        console.log(`[save-section] music ✅`);
      } catch (e) { console.log(`[save-section] music failed: ${e.message}`); }
    }

    // تحميل الـ background
    const bgBuffer = await downloadFile(background.url);
    if (background.url.includes('unsplash.com')) background.type = 'image';
    const mediaType = background.type === 'image' ? 'image' : 'video';
    const bgPath = mediaType === 'video' ? videoPath : imagePath;
    fs.writeFileSync(bgPath, bgBuffer);

    // بناء الـ effects — Groq يحدد + defaults ذكية
    const effects = {
      fade: true,
      fade_duration: 0.5,
      color_grade: true,
      vignette: requestedEffects?.vignette ?? false,
      ken_burns: requestedEffects?.ken_burns ?? (mediaType === 'image'),
      ken_burns_dir: requestedEffects?.ken_burns_dir ?? 'in',
      blur: requestedEffects?.blur ?? false,
      sharpen: requestedEffects?.sharpen ?? false,
      film_grain: requestedEffects?.film_grain ?? false,
      chromatic: requestedEffects?.chromatic ?? false,
      hue_shift: requestedEffects?.hue_shift ?? false,
      lower_third: false,
      lower_third_text: on_screen_text || '',
      lower_third_font: language === 'arabic' ? 'cairo' : language === 'french' ? 'poppins' : 'montserrat',
      lower_third_fontsize: 28,
       subtitles: !!assPath,
       subtitles_path: assPath || '',
      title_card: requestedEffects?.title_card ?? false,
      title_text: requestedEffects?.title_text ?? '',
      title_font: requestedEffects?.title_font ?? 'almarai',
      title_start: requestedEffects?.title_start ?? 0,
      title_duration: requestedEffects?.title_duration ?? 2,
      speed: requestedEffects?.speed ?? 1.0,
      ...(requestedEffects || {})
    };

    const filters = buildVideoFilters(effects, mediaType, audioDuration, 640, 360);
    const vfString = filters.join(',');
    console.log(`[save-section] vf built (${filters.length} filters)`);

    // FFmpeg
    if (mediaType === 'video') {
      if (musicBuffer) {
        await execAsync(`ffmpeg -y -stream_loop -1 -i "${videoPath}" -i "${audioPath}" -stream_loop -1 -i "${musicPath}" -t ${audioDuration} -filter_complex "[1:a]volume=1[tts];[2:a]volume=0.15[music];[tts][music]amix=inputs=2:duration=first[aout]" -map 0:v:0 -map "[aout]" -vf "${vfString}" -c:v libx264 -crf 35 -preset ultrafast -r 30 -c:a aac -strict experimental "${outputPath}"`);
      } else {
        await execAsync(`ffmpeg -y -stream_loop -1 -i "${videoPath}" -i "${audioPath}" -t ${audioDuration} -map 0:v:0 -map 1:a:0 -vf "${vfString}" -c:v libx264 -crf 35 -preset ultrafast -r 30 -c:a aac -strict experimental "${outputPath}"`);
      }
    } else {
      if (musicBuffer) {
        await execAsync(`ffmpeg -y -loop 1 -i "${imagePath}" -i "${audioPath}" -stream_loop -1 -i "${musicPath}" -t ${audioDuration} -filter_complex "[1:a]volume=1[tts];[2:a]volume=0.15[music];[tts][music]amix=inputs=2:duration=first[aout]" -map 0:v:0 -map "[aout]" -vf "${vfString}" -c:v libx264 -crf 35 -preset ultrafast -r 30 -pix_fmt yuv420p -c:a aac -strict experimental "${outputPath}"`);
      } else {
        await execAsync(`ffmpeg -y -loop 1 -i "${imagePath}" -i "${audioPath}" -t ${audioDuration} -map 0:v:0 -map 1:a:0 -vf "${vfString}" -c:v libx264 -crf 35 -preset ultrafast -r 30 -pix_fmt yuv420p -c:a aac -strict experimental "${outputPath}"`);
      }
    }

    console.log(`[save-section] done ✅ size=${fs.statSync(outputPath).size}`);
    res.json({ success: true, order });

  } catch (err) {
    console.log(`[save-section] error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// CONCAT SAVED
// ================================================================
app.post('/concat-saved', async (req, res) => {
  const { orders } = req.body;
  console.log(`[concat-saved] orders=${JSON.stringify(orders)}`);
  try {
    const concatPath = '/tmp/concat.txt';
    const outputPath = '/tmp/final.mp4';
    for (const o of orders) {
      if (!fs.existsSync(`/tmp/section_${o}.mp4`))
        return res.status(400).json({ error: `Section ${o} not found` });
    }
    fs.writeFileSync(concatPath, orders.map(o => `file '/tmp/section_${o}.mp4'`).join('\n'));
    await execAsync(`ffmpeg -y -f concat -safe 0 -i "${concatPath}" -c:v libx264 -crf 35 -preset ultrafast -vf "scale=640:360,fps=30" -r 30 -c:a aac -async 1 "${outputPath}"`);
    const size = fs.statSync(outputPath).size;
    console.log(`[concat-saved] ✅ size=${size}`);
    res.json({ success: true, size, download: '/download-final' });
  } catch (err) {
    console.log(`[concat-saved] error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// DOWNLOAD FINAL
// ================================================================
app.get('/download-final', (req, res) => {
  const p = '/tmp/final.mp4';
  if (fs.existsSync(p)) {
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="final.mp4"');
    res.send(fs.readFileSync(p));
  } else {
    res.status(404).json({ error: 'Final video not found' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg API running on port ${PORT}`));
