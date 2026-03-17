#!/usr/bin/env python3
# ===== process.py =====
# معالجة الفيديو بـ MoviePy — النسخة الكاملة
# التأثيرات: Ken Burns, Fade, Lower Third, Subtitles,
#             Color Grade, Vignette, Watermark, Overlay Image,
#             Cross Dissolve, Title Card, Audio Fade

import sys
import json
import os
import numpy as np
from moviepy import (
    VideoFileClip, ImageClip, TextClip,
    CompositeVideoClip, concatenate_videoclips,
    AudioFileClip, ColorClip
)
from moviepy.video.fx import FadeIn, FadeOut, CrossFadeIn, CrossFadeOut

# ================================================================
# 1. HELPERS
# ================================================================

def load_clip(input_path, media_type, duration):
    """تحميل الكليب (صورة أو فيديو) وضبط المدة"""
    if media_type == 'image':
        clip = ImageClip(input_path).with_duration(duration)
    else:
        clip = VideoFileClip(input_path)
        if clip.duration < duration:
            loops = int(duration / clip.duration) + 1
            clip = concatenate_videoclips([clip] * loops).subclipped(0, duration)
        else:
            clip = clip.subclipped(0, duration)
    return clip


def resize_to_target(clip, width=640, height=360):
    """ضبط الحجم المستهدف"""
    return clip.resized((width, height))


# ================================================================
# 2. EFFECTS
# ================================================================

def apply_ken_burns(clip, duration, zoom_ratio=0.10, direction='in'):
    """
    Ken Burns Effect — zoom تدريجي مع pan خفيف
    direction: 'in' (zoom in) أو 'out' (zoom out)
    """
    w, h = clip.size

    def make_frame(t):
        if direction == 'in':
            scale = 1 + zoom_ratio * (t / duration)
        else:
            scale = (1 + zoom_ratio) - zoom_ratio * (t / duration)

        frame = clip.get_frame(t)
        new_w = int(w * scale)
        new_h = int(h * scale)

        # resize يدوي بـ numpy
        from PIL import Image
        img = Image.fromarray(frame)
        img = img.resize((new_w, new_h), Image.LANCZOS)

        # crop المنتصف
        x1 = (new_w - w) // 2
        y1 = (new_h - h) // 2
        img = img.crop((x1, y1, x1 + w, y1 + h))
        return np.array(img)

    return clip.transform(make_frame, apply_to='video')


def apply_fade(clip, fade_duration=0.5):
    """Fade in وFade out"""
    clip = clip.with_effects([
        FadeIn(fade_duration),
        FadeOut(fade_duration)
    ])
    return clip


def apply_cross_dissolve(clip, cross_duration=0.5):
    """Cross dissolve — للاستخدام عند الدمج بين sections"""
    clip = clip.with_effects([
        CrossFadeIn(cross_duration),
        CrossFadeOut(cross_duration)
    ])
    return clip


def apply_color_grade(clip, brightness=1.0, contrast=1.1, saturation=1.1):
    """
    Color Grading — تعديل السطوع والتباين والتشبع
    القيم الافتراضية تعطي مظهر سينمائي خفيف
    """
    def grade_frame(frame):
        img = frame.astype(np.float32)
        # brightness
        img = img * brightness
        # contrast
        img = (img - 128) * contrast + 128
        # saturation (على قناة اللون فقط)
        gray = img.mean(axis=2, keepdims=True)
        img = gray + (img - gray) * saturation
        return np.clip(img, 0, 255).astype(np.uint8)

    return clip.image_transform(grade_frame)


def apply_vignette(clip, strength=0.5):
    """Vignette — إظلام الحواف"""
    w, h = clip.size

    def make_vignette():
        Y, X = np.ogrid[:h, :w]
        cx, cy = w / 2, h / 2
        dist = np.sqrt(((X - cx) / cx) ** 2 + ((Y - cy) / cy) ** 2)
        mask = 1 - np.clip(dist * strength, 0, 1)
        return mask[:, :, np.newaxis]  # shape: (h, w, 1)

    vignette_mask = make_vignette()

    def apply_vignette_frame(frame):
        return np.clip(frame * vignette_mask, 0, 255).astype(np.uint8)

    return clip.image_transform(apply_vignette_frame)


def apply_lower_third(clip, text, duration=None, font_size=28,
                      text_color='white', bg_color=(0, 0, 0, 180)):
    """Lower Third — شريط نص في أسفل الشاشة"""
    if not text or not text.strip():
        return clip

    display_duration = min(duration or clip.duration, clip.duration)
    w = clip.w

    try:
        txt = TextClip(
            text=text,
            font_size=font_size,
            color=text_color,
            bg_color='rgba(0,0,0,0.7)',
            size=(w, None),
            method='caption',
            text_align='center'
        ).with_duration(display_duration).with_position(('center', 'bottom'))

        return CompositeVideoClip([clip, txt])
    except Exception as e:
        print(f"[process.py] lower_third warning: {e}")
        return clip


def apply_title_card(clip, text, start=0, duration=2.0,
                     font_size=48, color='white'):
    """Title Card — نص كبير في المنتصف"""
    if not text or not text.strip():
        return clip

    try:
        txt = TextClip(
            text=text,
            font_size=font_size,
            color=color,
            method='label'
        ).with_duration(duration).with_start(start).with_position('center')

        return CompositeVideoClip([clip, txt])
    except Exception as e:
        print(f"[process.py] title_card warning: {e}")
        return clip


def apply_subtitles(clip, subtitles):
    """
    Subtitles — ترجمة/كلام مؤقت مزامن
    subtitles: قائمة من [ {start, end, text} ]
    مثال: [{"start": 0, "end": 3, "text": "مرحباً"}, ...]
    """
    if not subtitles:
        return clip

    txt_clips = []
    w = clip.w

    for sub in subtitles:
        try:
            start = float(sub.get('start', 0))
            end = float(sub.get('end', start + 2))
            text = sub.get('text', '')
            if not text:
                continue

            duration = end - start
            txt = TextClip(
                text=text,
                font_size=32,
                color='white',
                bg_color='rgba(0,0,0,0.75)',
                size=(int(w * 0.85), None),
                method='caption',
                text_align='center'
            ).with_duration(duration)\
             .with_start(start)\
             .with_position(('center', 0.85), relative=True)

            txt_clips.append(txt)
        except Exception as e:
            print(f"[process.py] subtitle warning: {e}")

    if txt_clips:
        return CompositeVideoClip([clip] + txt_clips)
    return clip


def apply_watermark(clip, watermark_path, position='bottom-right',
                    opacity=0.4, scale=0.12):
    """Watermark — شعار شفاف"""
    if not watermark_path or not os.path.exists(watermark_path):
        return clip

    try:
        w_mark = (ImageClip(watermark_path)
                  .with_duration(clip.duration)
                  .resized(scale)
                  .with_opacity(opacity))

        pos_map = {
            'bottom-right': ('right', 'bottom'),
            'bottom-left':  ('left',  'bottom'),
            'top-right':    ('right', 'top'),
            'top-left':     ('left',  'top'),
            'center':       ('center', 'center')
        }
        w_mark = w_mark.with_position(pos_map.get(position, ('right', 'bottom')))
        return CompositeVideoClip([clip, w_mark])
    except Exception as e:
        print(f"[process.py] watermark warning: {e}")
        return clip


def apply_overlay_image(clip, overlay_path, position='center',
                        opacity=1.0, scale=0.4, start=0, duration=None):
    """Overlay Image — صورة فوق الفيديو"""
    if not overlay_path or not os.path.exists(overlay_path):
        return clip

    try:
        display_duration = duration or clip.duration
        overlay = (ImageClip(overlay_path)
                   .with_duration(display_duration)
                   .resized(scale)
                   .with_opacity(opacity)
                   .with_start(start)
                   .with_position(position))
        return CompositeVideoClip([clip, overlay])
    except Exception as e:
        print(f"[process.py] overlay_image warning: {e}")
        return clip


def apply_audio_fade(clip, fade_in=0.5, fade_out=0.5):
    """Audio Fade in/out للصوت"""
    if clip.audio is None:
        return clip
    audio = clip.audio
    audio = audio.audio_fadein(fade_in).audio_fadeout(fade_out)
    return clip.with_audio(audio)


# ================================================================
# 3. MAIN PROCESSOR
# ================================================================

def process_section(params):
    """
    المعالج الرئيسي — يأخذ params dict ويُطبّق التأثيرات المطلوبة

    params:
      input_path      : مسار الملف (صورة أو فيديو)
      output_path     : مسار الناتج
      media_type      : 'image' | 'video'
      duration        : مدة الكليب بالثواني
      effects         : قائمة التأثيرات المطلوبة (list of strings)
      on_screen_text  : نص الـ lower third
      subtitles       : قائمة [{start, end, text}]
      title_text      : نص الـ title card
      watermark_path  : مسار الـ watermark
      overlay_path    : مسار الـ overlay image
      ken_burns_dir   : 'in' | 'out'
      brightness      : float (default 1.0)
      contrast        : float (default 1.1)
      saturation      : float (default 1.1)
      vignette_strength: float (default 0.5)
      target_width    : int (default 640)
      target_height   : int (default 360)
    """

    input_path       = params['input_path']
    output_path      = params['output_path']
    media_type       = params.get('media_type', 'video')
    duration         = float(params.get('duration', 10))
    effects          = params.get('effects', ['ken_burns', 'fade'])
    on_screen_text   = params.get('on_screen_text', '')
    subtitles        = params.get('subtitles', [])
    title_text       = params.get('title_text', '')
    watermark_path   = params.get('watermark_path', '')
    overlay_path     = params.get('overlay_path', '')
    ken_burns_dir    = params.get('ken_burns_dir', 'in')
    brightness       = float(params.get('brightness', 1.0))
    contrast         = float(params.get('contrast', 1.1))
    saturation       = float(params.get('saturation', 1.1))
    vignette_str     = float(params.get('vignette_strength', 0.5))
    target_w         = int(params.get('target_width', 640))
    target_h         = int(params.get('target_height', 360))

    print(f"[process.py] START: {input_path} | type={media_type} | dur={duration}s")
    print(f"[process.py] effects: {effects}")

    # 1. تحميل الكليب
    clip = load_clip(input_path, media_type, duration)

    # 2. ضبط الحجم
    clip = resize_to_target(clip, target_w, target_h)

    # 3. تطبيق التأثيرات بالترتيب

    if 'ken_burns' in effects and media_type == 'image':
        clip = apply_ken_burns(clip, duration, direction=ken_burns_dir)

    if 'color_grade' in effects:
        clip = apply_color_grade(clip, brightness, contrast, saturation)

    if 'vignette' in effects:
        clip = apply_vignette(clip, vignette_str)

    if 'fade' in effects or 'fade_in' in effects or 'fade_out' in effects:
        clip = apply_fade(clip)

    if 'cross_dissolve' in effects:
        clip = apply_cross_dissolve(clip)

    # النصوص بعد كل التأثيرات البصرية

    if 'title_card' in effects and title_text:
        clip = apply_title_card(clip, title_text)

    if 'lower_third' in effects and on_screen_text:
        clip = apply_lower_third(clip, on_screen_text)

    if 'subtitles' in effects and subtitles:
        clip = apply_subtitles(clip, subtitles)

    if 'watermark' in effects and watermark_path:
        clip = apply_watermark(clip, watermark_path)

    if 'overlay_image' in effects and overlay_path:
        clip = apply_overlay_image(clip, overlay_path)

    if 'audio_fade' in effects:
        clip = apply_audio_fade(clip)

    # 4. حفظ بدون صوت — الصوت يُضاف لاحقاً بـ FFmpeg
    clip.without_audio().write_videofile(
        output_path,
        fps=30,
        codec='libx264',
        preset='ultrafast',
        logger=None
    )

    clip.close()
    print(f"[process.py] DONE: {output_path}")
    return output_path


# ================================================================
# 4. ENTRY POINT
# ================================================================

if __name__ == '__main__':
    """
    طريقتان للاستدعاء:

    1. JSON string (الأفضل):
       python3 process.py '{"input_path": "...", ...}'

    2. Arguments بسيطة (للتوافق مع الكود القديم):
       python3 process.py input output media_type duration text
    """

    if len(sys.argv) == 2 and sys.argv[1].startswith('{'):
        # JSON mode
        params = json.loads(sys.argv[1])
    else:
        # Legacy mode — للتوافق مع index.js القديم
        params = {
            'input_path':     sys.argv[1],
            'output_path':    sys.argv[2],
            'media_type':     sys.argv[3] if len(sys.argv) > 3 else 'video',
            'duration':       sys.argv[4] if len(sys.argv) > 4 else 10,
            'on_screen_text': sys.argv[5] if len(sys.argv) > 5 else '',
            'effects':        ['ken_burns', 'fade', 'lower_third', 'color_grade']
        }

    process_section(params)
